const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const webpush = require("web-push");

admin.initializeApp();
const db = admin.firestore();
const VAPID_PRIVATE_KEY = defineSecret("VAPID_PRIVATE_KEY");
const VAPID_SUBJECT = "mailto:admin@planovac-55294.firebaseapp.com";

exports.sendDueReminders = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Europe/Prague",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 1,
    secrets: [VAPID_PRIVATE_KEY],
  },
  async () => {
    const now = Date.now();
    const due = await db
      .collectionGroup("tasks")
      .where("reminderAtMs", ">", 0)
      .where("reminderAtMs", "<=", now)
      .limit(100)
      .get();

    if (due.empty) {
      logger.info("No reminders due");
      return;
    }

    for (const taskSnap of due.docs) {
      const task = taskSnap.data();
      if (task.done) continue;
      if (!task.reminderMinutes || task.reminderMinutes <= 0) continue;
      if (!task.reminderAtMs) continue;
      if (task.reminderSentAtMs === task.reminderAtMs) continue;

      // tasks live at users/{uid}/tasks/{taskId}
      const userRef = taskSnap.ref.parent.parent;
      if (!userRef) continue;
      const uid = userRef.id;

      // Claim this reminder transactionally so duplicate scheduler invocations
      // do not normally send the same reminder twice.
      const claimed = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(taskSnap.ref);
        const t = fresh.data() || {};
        if (t.done || !t.reminderAtMs || t.reminderAtMs !== task.reminderAtMs) return false;
        if (t.reminderSentAtMs === t.reminderAtMs) return false;
        if (t.reminderClaimedAtMs && now - t.reminderClaimedAtMs < 5 * 60 * 1000) return false;
        tx.update(taskSnap.ref, { reminderClaimedAtMs: now });
        return true;
      });

      if (!claimed) continue;

      try {
        const devicesSnap = await userRef.collection("devices").get();
        const subscriptions = devicesSnap.docs
          .map((d) => ({ ref: d.ref, subscription: d.get("subscription") }))
          .filter((d) => d.subscription && typeof d.subscription.endpoint === "string" && d.subscription.keys?.p256dh && d.subscription.keys?.auth);

        if (!subscriptions.length) {
          logger.info(`No Web Push subscriptions for user ${uid}`);
          await taskSnap.ref.update({ reminderClaimedAtMs: admin.firestore.FieldValue.delete() });
          continue;
        }

        const start = Number(task.start || 0);
        const hh = String(Math.floor(start / 60)).padStart(2, "0");
        const mm = String(start % 60).padStart(2, "0");
        const address = task.address ? `📍 ${task.address}` : "";
        const bodyParts = [`${hh}:${mm} · ${task.title || "Naplánovaný úkol"}`];
        if (address) bodyParts.push(address);
        if (task.phone) bodyParts.push(`☎️ ${task.phone}`);
        if (task.note) bodyParts.push(`📝 ${task.note}`);

        webpush.setVapidDetails(VAPID_SUBJECT, "BIKn2Lr6o_nT_YJfJnufit_8yCeDdZLdyI4RWbXE9YnXeP8YDUDdxujyZv4r5bfZ0n6XhlJV5tZYQ1Cweba_yt4", VAPID_PRIVATE_KEY.value());

        const payload = JSON.stringify({
          web_push: 8030,
          notification: {
            title: "Můj plán",
            body: bodyParts.join("\n"),
            navigate: "./",
            tag: String(taskSnap.id),
            silent: false
          },
          title: "Můj plán",
          body: bodyParts.join("\n"),
          taskId: String(taskSnap.id),
          url: "./"
        });

        let successCount = 0;
        let failureCount = 0;
        const cleanup = [];
        for (const item of subscriptions) {
          try {
            await webpush.sendNotification(item.subscription, payload, { TTL: 3600, urgency: "high" });
            successCount++;
          } catch (err) {
            failureCount++;
            const status = err?.statusCode;
            if (status === 404 || status === 410) cleanup.push(item.ref.delete().catch(() => undefined));
            logger.warn(`Web Push failed for ${item.ref.path}: ${status || err?.message || err}`);
          }
        }
        await Promise.all(cleanup);

        await taskSnap.ref.update({
          reminderSentAtMs: task.reminderAtMs,
          reminderClaimedAtMs: admin.firestore.FieldValue.delete(),
        });

        logger.info(`Reminder sent for ${taskSnap.ref.path}: ${successCount} success, ${failureCount} failed`);
      } catch (err) {
        logger.error(`Reminder failed for ${taskSnap.ref.path}`, err);
        await taskSnap.ref.update({
          reminderClaimedAtMs: admin.firestore.FieldValue.delete(),
        });
      }
    }
  }
);
