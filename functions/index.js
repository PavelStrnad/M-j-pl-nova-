const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const appUrl = "https://pavelstrnad.github.io/M-j-pl-nova-/";

exports.sendPlannerReminders = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Europe/Prague", region: "europe-west1" },
  async () => {
    const now = Date.now();
    const snap = await db.collectionGroup("tasks")
      .where("reminderAtMs", ">", 0)
      .where("reminderAtMs", "<=", now)
      .get();

    for (const taskDoc of snap.docs) {
      const task = taskDoc.data();
      if (task.done || task.reminderSentAtMs) continue;

      const userDoc = taskDoc.ref.parent.parent;
      if (!userDoc) continue;
      const devicesSnap = await userDoc.collection("devices").get();
      const devices = devicesSnap.docs.map(d => ({ ref: d.ref, ...d.data() })).filter(d => d.token);

      // If no device is registered, mark it handled so it cannot repeat forever.
      if (!devices.length) {
        await taskDoc.ref.update({ reminderSentAtMs: now });
        continue;
      }

      const tokens = devices.map(d => d.token).slice(0, 500);
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        data: {
          title: "Můj plán",
          body: `${task.title || "Naplánovaný úkol"}${task.address ? " · 📍 " + task.address : ""}`,
          taskId: String(taskDoc.id),
          url: appUrl
        }
      });

      const deletions=[];
      response.responses.forEach((r,i)=>{
        if(!r.success){
          const code=r.error?.code||"";
          if(code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) deletions.push(devices[i].ref.delete());
        }
      });
      await Promise.all(deletions);

      if(response.successCount>0 || response.failureCount===tokens.length){
        await taskDoc.ref.update({ reminderSentAtMs: now });
      }
    }
  }
);
