import express from 'express';
import { CronJob } from 'cron';
import * as admin from 'firebase-admin';
import http2 from "http2";
import jwt from "jsonwebtoken";
import dotenv from 'dotenv';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
dotenv.config();

const jobDicts: Record<string, CronJob> = {};

const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
const serviceAccountBuffer = Buffer.from(serviceAccountBase64!, 'base64');
const serviceAccount = JSON.parse(serviceAccountBuffer.toString('utf8'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
})
const db = admin.firestore();

function generateJwtToken() {
    const keyBase64 = process.env.APNS_KEY_BASE64;
    const privateKey = Buffer.from(keyBase64!, 'base64').toString('utf8');
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

  async function getScheduleTransport(trainLineCode: string, trainStationCode: string) {
        const queryParams = new URLSearchParams({
            line: trainLineCode,
            sta: trainStationCode,
          }).toString();

        const url = `https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?${queryParams}`;

        try {
            const response = await axios.get(url, {
              headers: {
                'Accept-Encoding': 'gzip',
                'Host': 'rt.data.gov.hk'
              },
            });
          
            return response.data;
          } catch (error) {
            console.error('Request failed:', error);
            throw error;
          }

}

function getIntervalWaitingTime(trainData: any, type: string): number {
    const trainInfo = type == 'UP' ? trainData.UP : trainData.DOWN;
    const arrivalTime = new Date(trainInfo[0]?.time);
    const currentTime = new Date(trainData.curr_time);
    const waitingTimeMs = arrivalTime.getTime() - currentTime.getTime();
    const waitingTimeSeconds = waitingTimeMs / 1000;
    return waitingTimeSeconds;
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
    const trainData = content?.data?.[`${trainLineCode}-${trainStationCode}`] ?? null;

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
            token: doc.data().token,
            userId: doc.data().userId
            }));
        if (snapshot.empty) {
            response.status(200).json({ success: false, message: 'userId not found' });
        } else if (userData[0]?.trainCode == `${trainLineCode}-${trainStationCode}` && jobDicts[userId]) {
            response.status(200).json({ success: false, message: 'live activity starting' });
        } else {
            const token = userData[0]?.token;
            const batch = db.batch();

            snapshot.docs.forEach(doc => {
              const docRef = doc.ref;
              batch.update(docRef, { trainCode: `${trainLineCode}-${trainStationCode}`});
            });
            await batch.commit();
            removeJob(userId);

            const data = await getScheduleTransport(trainLineCode, trainStationCode)
            sendActivityNotification(process.env.PUSH_NOTIFICATION_URL_DEV ?? '', token, 'update', data, trainLineCode, trainStationCode, type);
                    
            let cnt = 1;
            const preriodTime = 30;
            const timeStopLiveActivity = 15 * 60;
            const job = new CronJob(
                '*/30 * * * * *',
                async function () {
                    const data = await getScheduleTransport(trainLineCode, trainStationCode)
                    sendActivityNotification(process.env.PUSH_NOTIFICATION_URL_DEV ?? '', token, 'update', data, trainLineCode, trainStationCode, type);
                    
                    cnt += 1;
                    if (cnt * preriodTime >= timeStopLiveActivity) {
                        removeJob(userId);
                    }
                },
                null,
                false,
                'America/Los_Angeles'
            );
            job.start();
            addJob(job, userId);
            response.status(200).json({ success: true });
        }
    }
});

function addJob(job: CronJob, userId: string) {
    jobDicts[userId] = job;
}

function removeJob(userId: string) {
    const job = jobDicts[userId];
    job?.stop();
    delete jobDicts[userId];
}

app.post('/stopLiveActivity', async (request, response) => {
    const { userId } = request.body;
    if (!userId) {
        response.status(200).json({ success: false, message: 'userId must provide' });
    } else {
        removeJob(userId);
        response.status(200).json({ success: true });
    }
});

app.post('/saveActivityToken', async (request, response) => {
    const { token, userId } = request.body;
    if (!token || !userId) {
        response.status(200).json({ success: false, message: 'userId and token must provide' });
    } else {
        const userData = {
            userId,
            token
        }
        const snapshots = await db.collection("activityTokens").where("userId", "==", userId).get();

        if (snapshots.empty) {
            await db.collection('activityTokens').add(userData);
        } else {
            const docRef = snapshots.docs[0].ref;
            await docRef.update(userData);
        }
        console.log('save device token', token);
        response.status(200).json({ success: true });
    }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
