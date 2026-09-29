const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

exports.sendDueReminders = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Europe/Prague",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 1,
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
        const tokens = devicesSnap.docs
          .map((d) => d.get("token"))
          .filter((t) => typeof t === "string" && t.length > 0);

        if (!tokens.length) {
          logger.info(`No notification devices for user ${uid}`);
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

        const messages = tokens.map((token) => ({
          token,
          data: {
            title: "Můj plán",
            body: bodyParts.join("\n"),
            taskId: String(taskSnap.id),
            url: "./",
          },
          webpush: {
            headers: {
              Urgency: "high",
            },
          },
        }));

        const batch = await messaging.sendEach(messages);

        // Remove invalid registrations.
        const cleanup = [];
        batch.responses.forEach((resp, i) => {
          const code = resp.error && resp.error.code;
          if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
            const token = tokens[i];
            const deviceDoc = userRef.collection("devices").doc(encodeURIComponent(token));
            cleanup.push(deviceDoc.delete().catch(() => undefined));
          }
        });
        await Promise.all(cleanup);

        await taskSnap.ref.update({
          reminderSentAtMs: task.reminderAtMs,
          reminderClaimedAtMs: admin.firestore.FieldValue.delete(),
        });

        logger.info(`Reminder sent for ${taskSnap.ref.path}: ${batch.successCount} success, ${batch.failureCount} failed`);
      } catch (err) {
        logger.error(`Reminder failed for ${taskSnap.ref.path}`, err);
        await taskSnap.ref.update({
          reminderClaimedAtMs: admin.firestore.FieldValue.delete(),
        });
      }
    }
  }
);
