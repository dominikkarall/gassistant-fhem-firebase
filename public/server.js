'use strict';

const fs = require('fs');
const path = require('path');
const version = require('./version');
const User = require('./user').User;
const log = require("./logger")._system;
const Logger = require('./logger').Logger;
const FHEM = require('./fhem').FHEM;
const FHEM_execute = require('./fhem').FHEM_execute;
const database = require('./database');

module.exports = {
    Server: Server
}

var firebaseListenerRegistered = false;

function Server() {
    this._config = this._loadConfig();
}

Server.prototype._loadConfig = function () {

    // Load up the configuration file
    let config;
    // Look for the configuration file
    const configPath = User.configPath();
    log.info("using " + configPath);
    
    // Complain and exit if it doesn't exist yet
    if (!fs.existsSync(configPath)) {
        log.error("Couldn't find config.json at " + configPath + ", using default values.");
        config =
          {
              "connections": [
                  {
                      "name": "FHEM",
                      "server": "127.0.0.1",
                      "port": "8083",
                      "webname": "fhem",
                      "filter": "room=GoogleAssistant"
                  }
              ]
          };
    } else {
      try {
          config = JSON.parse(fs.readFileSync(configPath));
      }
      catch (err) {
          log.error("There was a problem reading your config.json file.");
          log.error("Please try pasting your config.json file here to validate it: http://jsonlint.com");
          log.error("");
          throw err;
      }
    }

    log.info("---");
    log.info('config:\n' + JSON.stringify(config) + '\n');
    log.info("---");

    return config;
}

Server.prototype.startServer = function () {
  registerFirestoreListener.bind(this)();
}

async function handler(event, callback) {
    if (!event.msg) {
        //something was deleted in firestore, no need to handle
        return;
    }
    
    log.info("Received firestore2fhem: " + JSON.stringify(event));

    try {

        switch (event.msg) {

            case 'EXECUTE':
                require('./fhem').FHEM_execute({base_url: event.connection}, event.cmd);
                break;

            case 'REPORTSTATEALL':
                setTimeout(require('./database').reportStateAll, parseInt(event.delay) * 1000);
                break;

            case 'UPDATE_SYNCFEATURELEVEL':
                for (var fhem of this.connections) {
                    fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-usedFeatureLevel ' + event.featurelevel);
                    fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-googleSync Google SYNC finished');
                }
                break;

            case 'UPDATE_SERVERFEATURELEVEL':
                for (var fhem of this.connections) {
                    fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-availableFeatureLevel ' + event.featurelevel);
                }
                break;

            case 'LOG_ERROR':
                for (var fhem of this.connections) {
                    fhem.execute('setreading ' + fhem.gassistant + ' gassistant-fhem-lastServerError ' + event.log);
                }
                break;

            case 'UPDATE_CLIENT':
                log.info("#################################################");
                log.info("#################################################");
                log.info("#################################################");
                log.info("#################################################");
                log.info("!!!!!!!!PLEASE UPDATE YOUR CLIENT ASAP!!!!!!!!!!!");
                log.info("#################################################");
                log.info("#################################################");
                log.info("#################################################");
                log.info("#################################################");
                break;
                
            case 'STOP_CLIENT':
                process.exit(1);
                break;

            default:
                log.info("Error: Unsupported event", event);

                //TODO response = handleUnexpectedInfo(requestedNamespace);

                break;

        }// switch

    } catch (error) {

        log.error(error);

    }// try-catch

    //return response;

}// exports.handler

function registerFirestoreListener() {
  if (firebaseListenerRegistered)
    return undefined;
  //TODO delete all docs in the collection to prevent using old data
  try {
    database.getDB().collection(database.getUid()).doc('msgs').collection('firestore2fhem').onSnapshot((events) => {
      events.forEach((event) => {
        log.info('GOOGLE MSG RECEIVED: ' + JSON.stringify(event.data()));
        if (event.data()) {
          if (event.data().ts) {
            if (event.data().ts > (Date.now()-5000)) {
              handler.bind(this)(event.data());
            }
          }
        }
        event.ref.delete();
      });
    });
    firebaseListenerRegistered = true;
  } catch(err) {
    log.error('onSnapshot failed: ' + err);
  }
}

Server.prototype.run = function () {
    log.info('Google Assistant FHEM Connect ' + version + ' started');

    if (!this._config.connections) {
        log.error('no connections in config file');
        process.exit(-1);
    }

    database.initFirebase();

    log.info('Fetching FHEM connections...');

    this.devices = {};
    this.connections = [];
    var fhem;
    for (var connection of this._config.connections) {
        fhem = new FHEM(Logger.withPrefix(connection.name), connection, this);

        this.connections.push(fhem);
    }
}

Server.prototype.startConnection = async function() {
  log.info('Start Connection and listen for Firebase');
  database.reportClientVersion();
  database.clientHeartbeat();
  
  //register listener
  this.startServer();
  //load devices
  this.roomOfIntent = {};
  for (var fhem of this.connections) {
    fhem.connect();
  }
  
  checkFeatureLevel.bind(this)();
}

async function checkFeatureLevel() {
  var server = await database.getServerFeatureLevel();
  var sync = await database.getSyncFeatureLevel();
  log.info('SERVER FeatureLevel:' + JSON.stringify(server));
  log.info('SYNC   FeatureLevel:' + JSON.stringify(sync));

  if (server.featurelevel > sync.featurelevel) {
    //set changelog
    log.info('>>> VERSION UPGRADE STARTED');
    for (var fhem of this.connections) {
      await fhem.reload();
    }
    await database.initiateSync();
    log.info('>>> VERSION UPGRADE FINISHED - SYNC INITIATED');
  }

  await checkFeatureLevelTimer(this);
}

async function checkFeatureLevelTimer(thisObj) {
  //update every 1-4 days
  setTimeout(checkFeatureLevel.bind(thisObj), 86400000 + Math.floor(Math.random() * Math.floor(259200000)));
  //setTimeout(checkFeatureLevel.bind(thisObj), 5000 + Math.floor(Math.random() * Math.floor(20000)));
}


var log2 = function (title, msg) {

    console.log('**** ' + title + ': ' + JSON.stringify(msg));

}// log
