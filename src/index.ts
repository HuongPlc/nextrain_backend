import express from 'express';
import { CronJob } from 'cron';
import * as admin from 'firebase-admin';
import http2 from "http2";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import dotenv from 'dotenv';
import * as serviceAccount from '../train-b4416-firebase-adminsdk-udrt3-c0f7d9bc30.json';

const app = express();
const port = 3000;
app.use(express.json());
dotenv.config();

const params = {
    type: serviceAccount.type,
    projectId: serviceAccount.project_id,
    privateKeyId: serviceAccount.private_key_id,
    privateKey: serviceAccount.private_key,
    clientEmail: serviceAccount.client_email,
    clientId: serviceAccount.client_id,
    authUri: serviceAccount.auth_uri,
    tokenUri: serviceAccount.token_uri,
    authProviderX509CertUrl: serviceAccount.auth_provider_x509_cert_url,
    clientC509CertUrl: serviceAccount.client_x509_cert_url
  }

  admin.initializeApp({
    credential: admin.credential.cert(params),
  })
const db = admin.firestore();

function generateJwtToken() {
    const privateKeyPath = path.resolve(__dirname, "./AuthKey_F39W5LL4SH.p8");
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    const token = jwt.sign(
      {
        iss: process.env.TEAM_ID,
        iat: Math.floor(Date.now() / 1000),
      },
      privateKey,
      {
        algorithm: 'ES256',
        header: {
          alg: 'ES256',
          kid: process.env.KEY_ID,
        },
      }
    );
  
    return token;
  }

  async function getScheduleTransport(trainLineCode: string, trainStationCode: string): Promise<any> {
    return new Promise((resolve, reject) =>  {
        const client = http2.connect('https://rt.data.gov.hk');

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
            } catch (err) {
                reject(err);
            }
        });
        req.end();
    });
}

function getIntervalWaitingTime(trainData: any, type: string): number {
    const trainInfo = type == 'UP' ? trainData.UP : trainData.DOWN;
    const arrivalTime = new Date(trainInfo[0].time);
    const currentTime = new Date(trainData.curr_time);
    const waitingTimeMs = arrivalTime.getTime() - currentTime.getTime();
    const waitingTimeSeconds = waitingTimeMs / 1000;
    return waitingTimeSeconds;
}

async function updateDatabaseStopLive(userId: string) {
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

function getWaitingTime(waitingTimeSeconds: number): string {
    if (waitingTimeSeconds <= 0) {
      return "trainDeparting";
    } else if (waitingTimeSeconds > 0 && waitingTimeSeconds < 60) {
      return "trainArriving";
    } else {
      const minutes = Math.floor(waitingTimeSeconds / 60);
      return `${minutes} ${"minutes"}`;
    }
  }

function sendActivityNotification(url: string, deviceToken: string, event: string, content: any, trainLineCode: string, trainStationCode: string, type: string) {
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
    const client = http2.connect(url);

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
    } else {
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
        } else if (userData[0].trainCode == `${trainLineCode}-${trainStationCode}` && userData[0].isStartLiveActivity) {
            response.status(200).json({ success: false, message: 'live activity starting' });
        } else {
            const token = userData[0].token;
            const batch = db.batch();

            snapshot.docs.forEach(doc => {
              const docRef = doc.ref;
              batch.update(docRef, { trainCode: `${trainLineCode}-${trainStationCode}`, isStartLiveActivity: true});
            });
            await batch.commit();

            getScheduleTransport(trainLineCode, trainStationCode)
            .then((json) => {
                sendActivityNotification(process.env.PUSH_NOTIFICATION_URL_DEV ?? '', token, 'start', json, trainLineCode, trainStationCode, type);
            });
            let cnt = 1;
            const preriodTime = 30;
            const timeStopLiveActivity = 15 * 60;
            const job = new CronJob(
                '*/30 * * * * *',
                async function () {
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
                    if (userData[0].trainCode == '') {
                        job.stop();
                    } else {
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
                },
                null,
                false,
                'America/Los_Angeles'
            );
            job.start();
            response.status(200).json({ success: true });
        }
    }
});

app.post('/stopLiveActivity', async (request, response) => {
    const { userId } = request.body;
    if (!userId) {
        response.status(200).json({ success: false, message: 'userId must provide' });
    } else {
        await updateDatabaseStopLive(userId);
        response.status(200).json({ success: true });
    }
});

app.post('/saveActivityToken', async (request, response) => {
    const { token, userId } = request.body;
    if (!token || !userId) {
        response.status(200).json({ success: false, message: 'userId and token must provide' });
    } else {
        await db.collection('activityTokens').add({
            userId,
            token
        })
        console.log('save device token', token, userId);
        response.status(200).json({ success: true });
    }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
