"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cron_1 = require("cron");
const admin = __importStar(require("firebase-admin"));
const http2_1 = __importDefault(require("http2"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const dotenv_1 = __importDefault(require("dotenv"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
app.use(express_1.default.json());
dotenv_1.default.config();
const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
const serviceAccountBuffer = Buffer.from(serviceAccountBase64, 'base64');
const serviceAccount = JSON.parse(serviceAccountBuffer.toString('utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
function generateJwtToken() {
    const keyBase64 = process.env.APNS_KEY_BASE64;
    const privateKey = Buffer.from(keyBase64, 'base64').toString('utf8');
    const token = jsonwebtoken_1.default.sign({
        iss: process.env.TEAM_ID,
        iat: Math.floor(Date.now() / 1000),
    }, privateKey, {
        algorithm: 'ES256',
        header: {
            alg: 'ES256',
            kid: process.env.KEY_ID,
        },
    });
    return token;
}
async function getScheduleTransport(trainLineCode, trainStationCode) {
    return new Promise((resolve, reject) => {
        const client = http2_1.default.connect('https://rt.data.gov.hk');
        const queryParams = new URLSearchParams({
            line: trainLineCode,
            sta: trainStationCode,
        }).toString();
        const req = client.request({
            ':method': 'GET',
            ':path': `/v1/transport/mtr/getSchedule.php?${queryParams}`,
            'content-type': 'application/json',
            'accept-encoding': 'gzip',
            'content-length': 0,
            'host': 'rt.data.gov.hk'
        });
        let data = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            data += chunk;
        });
        req.on('end', () => {
            try {
                const json = JSON.parse(data);
                client.close();
                resolve(json);
            }
            catch (err) {
                reject(err);
            }
        });
        req.end();
    });
}
function getIntervalWaitingTime(trainData, type) {
    const trainInfo = type == 'UP' ? trainData.UP : trainData.DOWN;
    const arrivalTime = new Date(trainInfo[0].time);
    const currentTime = new Date(trainData.curr_time);
    const waitingTimeMs = arrivalTime.getTime() - currentTime.getTime();
    const waitingTimeSeconds = waitingTimeMs / 1000;
    return waitingTimeSeconds;
}
async function updateDatabaseStopLive(userId) {
    const snapshot = await db
        .collection("activityTokens")
        .where("userId", "==", userId)
        .get();
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
        const docRef = doc.ref;
        batch.delete(docRef);
    });
    await batch.commit();
}
function getWaitingTime(waitingTimeSeconds) {
    if (waitingTimeSeconds <= 0) {
        return "trainDeparting";
    }
    else if (waitingTimeSeconds > 0 && waitingTimeSeconds < 60) {
        return "trainArriving";
    }
    else {
        const minutes = Math.floor(waitingTimeSeconds / 60);
        return `${minutes} ${"minutes"}`;
    }
}
function sendActivityNotification(url, deviceToken, event, content, trainLineCode, trainStationCode, type) {
    const trainData = content.data?.[`${trainLineCode}-${trainStationCode}`] ?? null;
    if (!trainData) {
        return;
    }
    const waitingIntervalTime = getIntervalWaitingTime(trainData, type);
    const estimatedWaitingTime = getWaitingTime(waitingIntervalTime);
    const timestamp = Math.floor(Date.now() / 1000);
    if (waitingIntervalTime <= 0) {
        return;
    }
    const authenticationToken = generateJwtToken();
    const client = http2_1.default.connect(url);
    const headers = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        ':scheme': 'https',
        'authorization': `bearer ${authenticationToken}`,
        'apns-topic': process.env.APNS_TOPIC,
        'apns-push-type': 'liveactivity',
        'apns-priority': 10,
    };
    const payload = {
        aps: {
            'event': event,
            'timestamp': timestamp,
            'content-state': {
                'estimatedWaitingTime': estimatedWaitingTime,
                'currentTime': content.curr_time,
                'trainNo': type == 'UP' ? trainData.UP[0].plat : trainData.DOWN[0].plat,
                'waitingIntervalTime': waitingIntervalTime
            },
        },
    };
    console.log('this is payload', payload, waitingIntervalTime);
    const request = client.request(headers);
    request.on("response", (headers, flags) => {
        const statusCode = headers[':status'];
        console.log('this status', statusCode);
        if (statusCode !== 200 && url === process.env.PUSH_NOTIFICATION_URL_DEV) {
            sendActivityNotification(process.env.PUSH_NOTIFICATION_URL_PROD ?? '', deviceToken, event, content, trainLineCode, trainStationCode, type);
        }
    });
    request.setEncoding('utf8');
    request.write(JSON.stringify(payload));
    request.end();
    let data = '';
    request.on('data', (chunk) => {
        data += chunk;
    });
    request.on('end', () => {
        client.close();
    });
}
app.post('/startLiveActivity', async (request, response) => {
    const { userId, trainLineCode, trainStationCode, type } = request.body;
    if (!userId) {
        response.status(200).json({ success: false, message: 'userId must provide' });
    }
    else {
        const snapshot = await db
            .collection("activityTokens")
            .where("userId", "==", userId)
            .get();
        const userData = snapshot.docs.map(doc => ({
            id: doc.id,
            trainCode: doc.data().trainCode,
            isStartLiveActivity: doc.data().isStartLiveActivity,
            token: doc.data().token,
            userId: doc.data().userId
        }));
        if (snapshot.empty) {
            response.status(200).json({ success: false, message: 'userId not found' });
        }
        else if (userData[0].trainCode == `${trainLineCode}-${trainStationCode}` && userData[0].isStartLiveActivity) {
            response.status(200).json({ success: false, message: 'live activity starting' });
        }
        else {
            const token = userData[0].token;
            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                const docRef = doc.ref;
                batch.update(docRef, { trainCode: `${trainLineCode}-${trainStationCode}`, isStartLiveActivity: true });
            });
            await batch.commit();
            getScheduleTransport(trainLineCode, trainStationCode)
                .then((json) => {
                sendActivityNotification(process.env.PUSH_NOTIFICATION_URL_DEV ?? '', token, 'start', json, trainLineCode, trainStationCode, type);
            });
            let cnt = 1;
            const preriodTime = 30;
            const timeStopLiveActivity = 15 * 60;
            const job = new cron_1.CronJob('*/30 * * * * *', async function () {
                const snapshot = await db
                    .collection("activityTokens")
                    .where("userId", "==", userId)
                    .get();
                const userData = snapshot.docs.map(doc => ({
                    id: doc.id,
                    trainCode: doc.data().trainCode,
                    isStartLiveActivity: doc.data().isStartLiveActivity,
                    token: doc.data().token,
                    userId: doc.data().userId
                }));
                if (userData[0]?.trainCode == '') {
                    job.stop();
                }
                else {
                    getScheduleTransport(trainLineCode, trainStationCode)
                        .then((json) => {
                        sendActivityNotification(process.env.PUSH_NOTIFICATION_URL_DEV ?? '', token, 'update', json, trainLineCode, trainStationCode, type);
                    });
                    cnt += 1;
                    if (cnt * preriodTime >= timeStopLiveActivity) {
                        job.stop();
                        updateDatabaseStopLive(userId);
                    }
                }
            }, null, false, 'America/Los_Angeles');
            job.start();
            response.status(200).json({ success: true });
        }
    }
});
app.post('/stopLiveActivity', async (request, response) => {
    const { userId } = request.body;
    if (!userId) {
        response.status(200).json({ success: false, message: 'userId must provide' });
    }
    else {
        await updateDatabaseStopLive(userId);
        response.status(200).json({ success: true });
    }
});
app.post('/saveActivityToken', async (request, response) => {
    const { token, userId } = request.body;
    if (!token || !userId) {
        response.status(200).json({ success: false, message: 'userId and token must provide' });
    }
    else {
        await db.collection('activityTokens').add({
            userId,
            token
        });
        console.log('save device token', token, userId);
        response.status(200).json({ success: true });
    }
});
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
