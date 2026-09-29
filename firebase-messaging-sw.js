importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyD0Pv7jVDxbjqYEceizigXHa-VnDMTemlE",
  authDomain: "planovac-55294.firebaseapp.com",
  projectId: "planovac-55294",
  storageBucket: "planovac-55294.firebasestorage.app",
  messagingSenderId: "945202835965",
  appId: "1:945202835965:web:1bab0c7ffc9bf4b29c2994"
});

const messaging=firebase.messaging();
messaging.onBackgroundMessage(payload=>{
  const data=payload.data||{};
  const title=data.title||"Můj plán";
  const options={body:data.body||"Máš naplánovaný úkol.",tag:data.taskId||"plan-reminder",data:{url:data.url||"./"}};
  self.registration.showNotification(title,options);
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const url=event.notification.data?.url||"./";
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
    for(const c of list){if("focus" in c)return c.focus();}
    if(clients.openWindow)return clients.openWindow(url);
  }));
});
