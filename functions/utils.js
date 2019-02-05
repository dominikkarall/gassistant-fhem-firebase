const admin = require("firebase-admin");
const functions = require("firebase-functions");
const jwt = require('express-jwt');
const jwks = require('jwks-rsa');
const jsonwt = require('jsonwebtoken');
const uidlog = require('./logger').uidlog;
const uiderror = require('./logger').uiderror;
const settings = require('./settings.json');

var allDevices = {};
var allInformIds = {};
var googleToken = '';

const jwtCheck = jwt({
	secret: jwks.expressJwtSecret({
          cache: true,
	  rateLimit: true,
	  jwksRequestsPerMinute: 5,
	  jwksUri: settings.AUTH0_DOMAIN + '/.well-known/jwks.json',
	}),
	audience: settings.AUDIENCE_URI,
	issuer: settings.AUTH0_DOMAIN + '/',
	algorithms: ['RS256']
});

function createDirective(reqId, payload) {
    return {
        requestId: reqId,
        payload: payload
    };
}// createDirective

async function loadDevice(uid, devicename) {
  //TODO cache also just one device
  if (allDevices[uid] && allDevices[uid][devicename]) {
    return allDevices[uid][devicename];
  }

  var docRef = await admin.firestore().collection(uid).doc('devices').collection('attributes').doc(devicename).get();
  var device = docRef.data();
  if (!device || !device.mappings) {
    uiderror(uid, 'No mappings defined for ' + devicename);
    throw new Error('No mappings defined for ' + devicename);
  }
  for (characteristic_type in device.mappings) {
    let mappingChar = device.mappings[characteristic_type];
    //mappingChar = Modes array

    if (!Array.isArray(mappingChar))
      mappingChar = [mappingChar];

    let mappingRoot;
    for (mappingRoot in mappingChar) {
      mappingRoot = mappingChar[mappingRoot];
      //mappingRoot = first element of Modes array
      if (!Array.isArray(mappingRoot))
	      mappingRoot = [mappingRoot];

      for (mappingElement in mappingRoot) {
  			mapping = mappingRoot[mappingElement];
  			
        if (mapping.reading2homekit) {
          eval('mapping.reading2homekit = ' + mapping.reading2homekit);
        }
        if (mapping.homekit2reading) {
          eval('mapping.homekit2reading = ' + mapping.homekit2reading);
        }
      }
    }
  }
  return device;
}

async function loadDevices(uid, nocache) {
  if (nocache) {
    delete allDevices[uid];
  }
  
  if (!allDevices[uid])
    allDevices[uid] = {};
  else {
    return allDevices[uid];
  }
  
  var devices = {};
  var attributesRef = await admin.firestore().collection(uid).doc('devices').collection('attributes');
  var attrRef = await attributesRef.get();
  for (attr of attrRef.docs) {
    var d = attr.data();
    for (characteristic_type in d.mappings) {
      let mappingChar = d.mappings[characteristic_type];
      //mappingChar = Modes array

      if (!Array.isArray(mappingChar))
        mappingChar = [mappingChar];

      let mappingRoot;
      for (mappingRoot in mappingChar) {
	      mappingRoot = mappingChar[mappingRoot];
	      //mappingRoot = first element of Modes array
	      if (!Array.isArray(mappingRoot))
		      mappingRoot = [mappingRoot];

	      for (mappingElement in mappingRoot) {
    			mapping = mappingRoot[mappingElement];
    			
          if (mapping.reading2homekit) {
            eval('mapping.reading2homekit = ' + mapping.reading2homekit);
          }
          if (mapping.homekit2reading) {
            eval('mapping.homekit2reading = ' + mapping.homekit2reading);
          }
        }
      }
    }
    devices[d.name] = d;
    allDevices[uid][d.name] = d;
  }
  return devices;
}

async function getGoogleToken() {
  if (googleToken != '')
    return googleToken;

  var googleTokenRef = await admin.firestore().collection('settings').doc('googletoken').get();

  if (googleTokenRef.data() && googleTokenRef.data().token)
    return googleTokenRef.data().token;

  return undefined;
}

function setGoogleToken(google_token) {
  googleToken = google_token;
  admin.firestore().collection('settings').doc('googletoken').set({token: google_token})
    .then(r => {});
}

async function getSyncFeatureLevel(uid) {
  var state = await admin.firestore().collection(uid).doc('state').get();

  if (state.data() && state.data().featurelevel)
    return state.data().featurelevel;

  return 0;
}

async function getInformId(uid, informId) {
  if (!allInformIds[uid])
    allInformIds[uid] = {};

    //var informIdRef = await admin.firestore().collection(uid).doc('devices').collection('informids').doc(informId).get();
  var clientstate = await admin.database().ref('/users/' + uid + '/informids/' + informId).once('value');
  if (clientstate.val() && clientstate.val().value) {
    allInformIds[uid][informId] = {value: clientstate.val().value, device: clientstate.val().device};
    uidlog(uid, 'getInformId from db: ' + informId + ' = ' + allInformIds[uid][informId].value);
    return allInformIds[uid][informId].value;
  }
  
  //FIXME cache is not used any more
  if (allInformIds[uid] && allInformIds[uid][informId]) {
    //console.error('cached informid ' + informId + ' returned ' + allInformIds[uid][informId]);
    uidlog(uid, 'getInformId from cache: ' + informId + ' = ' + allInformIds[uid][informId].value);
    return allInformIds[uid][informId].value;
  }

  return undefined;
};

async function setInformId(uid, informId, device, val, options) {
  if (!val)
    val = '';

  if (!allInformIds[uid]) {
    allInformIds[uid] = {};
  }
  
  if (options && options.onlycache) {
    uidlog(uid, 'informid onlycache updated ' + informId + ' = ' + val);
    allInformIds[uid][informId] = {value: val, device: device};
  } else {
    if ((options && options.force) || !allInformIds[uid][informId] || allInformIds[uid][informId] != val) {
      //only update on change
      uidlog(uid, 'informid updated ' + informId + ' = ' + val);
      allInformIds[uid][informId] = {value: val, device: device};
      await admin.database().ref('/users/' + uid + '/informids/' + informId).set({value: val, device: device});
      //await admin.firestore().collection(uid).doc('devices').collection('informids').doc(informId).set({value: val}, {merge: true});
    }
  }
};

async function retrieveGoogleToken(uid) {
  var token = jsonwt.sign({
    "iss": settings.SERVICEACCOUNT,
    "scope": "https://www.googleapis.com/auth/homegraph",
    "aud": "https://accounts.google.com/o/oauth2/token"
  },
  settings.PRIVATE_KEY,
  {
    algorithm: 'RS256',
    expiresIn: 60*60
  });
  
  //sign JWT https://github.com/auth0/node-jsonwebtoken
  //request access token from https://accounts.google.com/o/oauth2/token
  //send POST to request a token
  const { URLSearchParams } = require('url');
  const params = new URLSearchParams();
  params.append('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  params.append('assertion', token);

  const fetch = require('node-fetch');
  var options = { method: 'POST',
    body: params
    };
  const response = await fetch('https://accounts.google.com/o/oauth2/token', options);
  var resJson = await response.json();
  
  uidlog(uid, 'access_token from Google: ' + await JSON.stringify(resJson));
  
  //access token from google
  return await resJson.access_token;
}


async function reportState(uid, informid, device) {
  const hquery = require('./handleQUERY');
  
  //FIXME device parameter missing, informid doesn't include device name
  
  var deviceQueryRes = await hquery.processQUERY(uid, {
      intent: 'action.devices.QUERY',
      payload: {
        devices: [{
          id: device,
          customData: {
            device: device
          }
        }]
      }
  });
  
  //prepare response
  var dev = {
    requestId: (Math.floor(Math.random() * Math.floor(1000000000000))).toString(),
    agentUserId: uid,
    payload: {
      devices: {
        states: {}
      }
    }
  };
  dev.payload.devices.states = deviceQueryRes.devices;
  
  //TODO check if token is already older than one hour and renew it if so
  var google_token = await getGoogleToken();
  if (!google_token)
    google_token = await retrieveGoogleToken(uid);

  //report state
  const fetch = require('node-fetch');
  for (var i=0; i<2; i++) {
    var options = { method: 'POST',
      headers: {
        Authorization: 'Bearer ' + google_token,
        'X-GFE-SSL': 'yes',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(dev)
    };
    const reportStateRes = await fetch('https://homegraph.googleapis.com/v1/devices:reportStateAndNotification', options);
    uidlog(uid, 'reportstateres: ' + await reportStateRes.status);
    
    if (reportStateRes.status == 401) {
      google_token = await retrieveGoogleToken(uid);
    } else if (reportStateRes.status == 404) {
      break;
    } else {
      //save the token to database
      setGoogleToken(google_token);
      break;
    }
  }
}

module.exports = {
  createDirective,
  jwtCheck,
  reportState,
  loadDevice,
  loadDevices,
  retrieveGoogleToken,
  getGoogleToken,
  setGoogleToken,
  getInformId,
  setInformId,
  getSyncFeatureLevel
};
