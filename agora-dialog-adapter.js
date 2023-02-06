import AgoraRTC from 'agora-rtc-sdk-ng';
import AgoraRTM from 'agora-rtm-sdk'
import { debug as newDebug } from "debug";
import EventEmitter from "eventemitter3";

const debug = newDebug("agora-dialog-adapter:debug");
const error = newDebug("agora-dialog-adapter:error");
const info = newDebug("agora-dialog-adapter:info");

export const DIALOG_CONNECTION_CONNECTED = "dialog-connection-connected";
export const DIALOG_CONNECTION_ERROR_FATAL = "dialog-connection-error-fatal";

export class DialogAdapter extends EventEmitter {

  constructor() {
    super();

    console.info("constructing Agora DialogAdapter");
    // If your Agora appId has tokens enabled then you can set a tokenAPI URL below to request a token
    // To quickly run an AWS Lambda token service see https://github.com/BenWeekes/agora-rtc-lambda
    // set Agora appId here

    this.appId = "Your App Id Here"; 
    // set token server if tokens are enabled else null
    this.tokenAPI = null; // e.g. "https://24volagzyvl2t3cziyxhiy7kpy0tdzke.lambda-url.us-east-1.on.aws/?channel="; 

    this.limitSubscriptions = true;  // set to false to always subscribe to all available streams (or the host limit of your appid which has a default of 16)
    this.maxAudioSubscriptions = 8;  // when more than this number of publishers are available then only the closest X neighbours will be subscribed to.
    this.maxAudioDistanceApart = -1;  // only subscribe to audio of people within this distance in hubs scene (in any direction)  or set to -1 for no limit 
    this.maxVideoSubscriptions = 6;  // when more than this number of publishers are available then only the closest X neighbours will be subscribed to.
    this.maxVideoDistanceApart = -1;  // only subscribe to video of people within this distance in hubs scene (in any direction) or set to -1 for no limit 
    this.processSubscriptonsAfter = 300; // time between subsequent subscription processes in ms (recommended 300 ms)
    this.channelCount = 1; // default 1, increase to allow more Agora channels to be used in parallel
    this.maxHostsPerChannel = 16; // default 16, number of hosts in Agora channel
    this.prioritiseAdmins = true; // treat admins as zero distance when deciding who to subscribe to
    this.enableVADControl = true;
    this.enableAgoraRTC = false;

    this.extension = null;
    this.processor = null;
    this.userid = null;
    this._micShouldBeEnabled = false;
    this._localMediaStream = null;
    this._pendingMediaRequests = new Map();
    this._blockedClients = new Map();
    this.scene = null;
    this._serverParams = {};
    this._consumerStats = {};

    this._agora_clients = [];
    this._agoraUserMap = {};
    this._myPublishClient = -1;
    this.localTracks = {
      videoTrack: null,
      audioTrack: null
    }

    this._videoSubscriptions = {};
    this._audioSubscriptions = {};
    this._adminUsers = {};
    this._vadPublisherByPriority = [];
    this._vadPublisherRecentByPriority = [];
    this._videoPublishers = {};
    this._audioPublishers = {};
    this._audioPubCount = 0;
    this._videoPubCount = 0;

    // RTM / VAD
    this.VAD = "VAD";
    this.NoVAD = "NOVAD";
    this.rtmClient;
    this.rtmUid;
    this.rtmChannelName;
    this.rtmChannel;
    this.RTMCHATSEPERATOR = "::";

    // VAD
    this.vadSend = 0;
    this.vadSendWait = 1 * 1000; // send every second while talking 
    this.vadRecv = 0;

    // Voice Activity Detection Internals
    this._voiceActivityDetectionFrequency = 150;
    this._vad_MaxAudioSamples = 400;
    this._vad_MaxBackgroundNoiseLevel = 30;
    this._vad_SilenceOffeset = 10;
    this._vad_SubceedOffeset = 2;
    this._vad_audioSamplesArr = [];
    this._vad_audioSamplesArrSorted = [];
    this._vad_exceedCount = 0;
    this._vad_subceedCount = -1;
    this._vad_subceedCountBegin = Math.round(5000 / this._voiceActivityDetectionFrequency); // 5s
    this._vad_exceedCountThreshold = 2;
    this._voiceActivityDetectionInterval;
    this._reenableMic = false;

  }

  // Returns the index of the first client object with an open channel.
  async getFirstOpenChannel() {

    if (this._myPublishClient > -1) {
      return this._myPublishClient;
    }

    this._myPublishClient = this.getFirstOpenChannelInner();
    if (this._myPublishClient < 0)
      return;

    
    if (!this.enableAgoraRTC) {
      console.warn("set client role host " + this._myPublishClient);
      await this._agora_clients[this._myPublishClient].setClientRole("host");
    }
    
    return this._myPublishClient;
  }


  // Returns the index of the first client object with an open channel.
  getFirstOpenChannelInner() {
    let tempCount = 0;
    for (var i = 0; i < this.channelCount; i++) {
      tempCount = this._agora_clients[i]._users.length;
      if (tempCount < this.maxHostsPerChannel) {
        return i;
      }
    }
    console.error("no channel space available");
    return -1;
  }

  async connect({
    serverUrl,
    roomId,
    joinToken,
    serverParams,
    scene,
    clientId
  }) {
    this._serverUrl = serverUrl;
    this._roomId = roomId;
    this._joinToken = joinToken;
    this._serverParams = serverParams;
    this._clientId = clientId;
    this.scene = scene;

    var that = this;

    var clientConfig;
    
    if (this.enableAgoraRTC)
      clientConfig={ codec: 'vp8', mode: 'rtc', };
    else
      clientConfig={ codec: 'vp8', mode: 'live', };


    for (var i = 0; i < this.channelCount; i++) {
      //this._agora_client = AgoraRTC.createClient({ codec: 'vp8', mode: 'rtc', });
      this._agora_clients[i] = AgoraRTC.createClient(clientConfig);
      let currentClient = this._agora_clients[i];

      this._agora_clients[i].on("user-joined", async (user) => {
        console.info("user-joined " + user.uid);
      });

      this._agora_clients[i].on("user-published", async (user, mediaType) => {
        var uid_string = user.uid.toString();

        that._agoraUserMap[uid_string] = user;
        if (mediaType === 'audio') {
          that._audioPublishers[uid_string] = currentClient;
          this._audioPubCount = this.getMapSize(this._audioPublishers);
        } else if (mediaType === 'video') {
          that._videoPublishers[uid_string] = currentClient;
          this._videoPubCount = this.getMapSize(this._videoPublishers);
        }


        try {
          if (window.APP.hubChannel.presence.state[uid_string].metas[0].roles.owner) {
            that._adminUsers[uid_string] = true;
          } else {
            delete that._adminUsers[uid_string];
          }
        } catch (e) {
          console.warn("no metas for " + uid_string);
        }

      });

      this._agora_clients[i].on("user-unpublished", async (user, mediaType) => {
        var uid_string = user.uid.toString();
        if (mediaType === 'audio') {
          delete that._audioPublishers[uid_string];
          this._audioPubCount = this.getMapSize(this._audioPublishers);
          that.removeUidFromArray(that._vadPublisherByPriority, uid_string);
          that.removeUidFromArray(that._vadPublisherRecentByPriority, uid_string);
        } else if (mediaType === 'video') {
          delete that._videoPublishers[uid_string];
          this._videoPubCount = this.getMapSize(this._videoPublishers);
        }

      });

      this._agora_clients[i].on("user-left", async (user, mediaType) => {
        var uid_string = user.uid.toString();
        delete that._agoraUserMap[uid_string];
        delete that._audioPublishers[uid_string];
        delete that._adminUsers[uid_string];
        that.removeUidFromArray(that._vadPublisherByPriority, uid_string);
        that.removeUidFromArray(that._vadPublisherRecentByPriority, uid_string);

        this._audioPubCount = this.getMapSize(this._audioPublishers);
        delete that._videoPublishers[uid_string];
        this._videoPubCount = this.getMapSize(this._videoPublishers);


        that.closeRemote(uid_string);
      });
    }

    // listen for presence updates
    window.APP.entryManager.scene.addEventListener("presence_updated", (update) => {
      if (update.detail.roles.owner) {
        that._adminUsers[update.detail.sessionId] = true;
      } else {
        delete that._adminUsers[update.detail.sessionId];
      }
    });

    return new Promise((resolve, reject) => {
      (async () => {
        try {
          await this._joinRoom();
          resolve();
          this.emit(DIALOG_CONNECTION_CONNECTED);
          this.manageSubscriptions();
        } catch (err) {
          reject(err);
          this.emit(DIALOG_CONNECTION_ERROR_FATAL);
        }
      })()
    });
  }

  // private
  async _joinRoom() {
    // request token
    if (this.tokenAPI !== null) {
      // Join one channel for each client object.
      for (var i = 0; i < this.channelCount; i++) {
        let tempChannelName = this._roomId;
        if (i > 0) {
          tempChannelName = this._roomId + "-" + i.toString();
        }
        let token_api = this.tokenAPI + tempChannelName + "&uid=" + this._clientId;
        try {
          const respJson = await fetch(`${token_api}`).then(r => r.json());
          let token = respJson.token;
          if (!this.enableAgoraRTC) {
            await this._agora_clients[i].setClientRole("audience");
          }
          await this._agora_clients[i].join(this.appId, tempChannelName, token, this._clientId);
        } catch (e) {
          console.error("Error fetching/using Agora Token ", e);
          return;
        }
      }
    } else {
      try {
        // Join one channel for each client object.
        for (var i = 0; i < this.channelCount; i++) {
          let tempChannelName = this._roomId;
          if (i > 0) {
            tempChannelName = this._roomId + "-" + i.toString();
          }

          if (!this.enableAgoraRTC) {
            await this._agora_clients[i].setClientRole("audience");
          }
          
          let uid=await this._agora_clients[i].join(this.appId, tempChannelName, null, this._clientId);
          console.info(" join Agora Channel " + tempChannelName+" as "+ uid);
        }
      } catch (e) {
        console.error("Failed to join Agora ", e);
        return;
      }
    }

    if (this.enableVADControl) {
      this.rtmChannelName = this._roomId
      this.rtmUid = this._clientId;
      this.initRTM();
      this._voiceActivityDetectionInterval = setInterval(() => {
        this.voiceActivityDetection();
      }, this._voiceActivityDetectionFrequency);
    }
    await this.setLocalMediaStream(this._localMediaStream);
  }

  closeRemote(clientId) {
    const pendingMediaRequests = this._pendingMediaRequests.get(clientId);
    if (pendingMediaRequests) {
      if (pendingMediaRequests.audio) {
        pendingMediaRequests.audio.resolve(null);
      }
      if (pendingMediaRequests.video) {
        pendingMediaRequests.video.resolve(null);
      }
      this._pendingMediaRequests.delete(clientId);
    }
  }

  resolvePendingMediaRequestForTrack(clientId, track) {
    const requests = this._pendingMediaRequests.get(clientId);
    if (requests && requests[track.kind]) {
      const resolve = requests[track.kind].resolve;
      delete requests[track.kind];
      resolve(new MediaStream([track]));
    }
    if (requests && Object.keys(requests).length === 0) {
      this._pendingMediaRequests.delete(clientId);
    }
  }

  getAgoraUser(clientId) {
    return this._agoraUserMap[clientId];
  }

  // public - returns promise 
  getMediaStream(clientId, kind = "audio") {
    console.info("getMediaStream ",clientId);
    let track;

    if (this._clientId === clientId) {
      // LOCAL USER
      if (kind === "audio" && this.localTracks.audioTrack) {
        track = this.localTracks.audioTrack._mediaStreamTrack;
      } else if (kind === "video" && this.localTracks.videoTrack) {
        track = this.localTracks.videoTrack._mediaStreamTrack;
      }
    } else {
      // REMOTE USERS
      let user = this.getAgoraUser(clientId);
      if (user && kind === "audio" && user.audioTrack && user.audioTrack._mediaStreamTrack) {
        track = user.audioTrack._mediaStreamTrack;
      } else if (user && kind === "video" && user.videoTrack && user.videoTrack._mediaStreamTrack) {
        track = user.videoTrack._mediaStreamTrack;
      }
    }

    if (track) {
      console.log(`Already had ${kind} for ${clientId}`);
      return Promise.resolve(new MediaStream([track]));
    } else {
      console.log(`Waiting on ${kind} for ${clientId}`);
      if (!this._pendingMediaRequests.has(clientId)) {
        this._pendingMediaRequests.set(clientId, {});
      }

      const requests = this._pendingMediaRequests.get(clientId);
      const promise = new Promise((resolve, reject) => (requests[kind] = { resolve, reject }));
      requests[kind].promise = promise;
      promise.catch(e => {
        console.warn(`${clientId} getMediaStream Error`, e);
      });
      return promise;
    }
  }

  // public - void 
  async setLocalMediaStream(stream, isDisplayMedia) {    
    if (this._myPublishClient > -1) {
      if (this.localTracks.videoTrack) {
        console.info("Agora unpublishing any video");
        await this._agora_clients[this._myPublishClient].unpublish(this.localTracks.videoTrack);
       this.localTracks.videoTrack=null;
      }
    }

    if (!stream) {
      return;
    }

    console.info("setLocalMediaStream ",stream.getTracks());
    await Promise.all(
      stream.getTracks().map(async track => {
        if (track.kind === "audio" && !this.localTracks.audioTrack) {
          // avoid unpublish / publish audio
          this.localTracks.audioTrack = await AgoraRTC.createCustomAudioTrack({
            mediaStreamTrack: stream.getAudioTracks()[0]
          });
          if (this.isMicEnabled()) {
            await this.getFirstOpenChannel();  //set host
            await this._agora_clients[this._myPublishClient].publish(this.localTracks.audioTrack);
          }
          this.emit("mic-state-changed", { enabled: this.isMicEnabled() });
          console.info("mic ",this.isMicEnabled() );

        } else if (track.kind === "video") {
          this.localTracks.videoTrack = await AgoraRTC.createCustomVideoTrack({
            mediaStreamTrack: stream.getVideoTracks()[0], bitrateMin: 600, bitrateMax: 1500, optimizationMode: 'motion'
          });
          if (this.localTracks && this.localTracks.videoTrack) {
            await this.getFirstOpenChannel(); // set host
            await this._agora_clients[this._myPublishClient].publish(this.localTracks.videoTrack);
          }
        }
        this.resolvePendingMediaRequestForTrack(this._clientId, track);
      })
    );
    this._localMediaStream = stream;
  }

  async enableCamera(track) {
  }

  async disableCamera() {
  }

  async enableShare(track) {
  }

  async disableShare() {
  }

  toggleMicrophone() {
    if (this.isMicEnabled()) {
      this._reenableMic = true;
      this.enableMicrophone(false);
    } else {
      this.enableMicrophone(true);
    }
  }

  async enableMicrophone(enabled) {
    console.info(" enableMicrophone ",enabled);
    if (!this.localTracks || !this.localTracks.audioTrack) {
      console.error("Tried to toggle mic but there's no mic.");
      enabled = false;
    } else {
      await this.localTracks.audioTrack.setEnabled(enabled);
      this.sendVADEvent(); // turned mic on with intention
    }
    this.emit("mic-state-changed", { enabled: enabled });
  }

  isMicEnabled() {
    return (this.localTracks && this.localTracks.audioTrack && this.localTracks.audioTrack._enabled);
  }

  get consumerStats() {
    return null;
  }

  get downlinkBwe() {
    return null;
  }

  async getServerStats() {
    return;
  }

  disconnect() {
  }

  kick(clientId) {
    document.body.dispatchEvent(new CustomEvent("kicked", { detail: { clientId: clientId } }));
  }

  block(clientId) {
    document.body.dispatchEvent(new CustomEvent("blocked", { detail: { clientId: clientId } }));
  }

  unblock(clientId) {
    document.body.dispatchEvent(new CustomEvent("unblocked", { detail: { clientId: clientId } }));
  }

  /*
  Code to limit subscriptions based on distance
  */

  getMapSize(x) {
    return Object.keys(x).length;
  }

  removeUidFromArray(array_, uid) {
    var index = array_.indexOf(uid);
    if (index > -1) {
      array_.splice(index, 1);
      return true;
    }
    return false;
  }

  async addAudioSubsIfNotExisting(expected) {
    Object.keys(expected).forEach(peerId => this.addAudioSubIfNotExisting(peerId))
  }

  async addAudioSubIfNotExisting(uid_string) {
    if (this._audioSubscriptions[uid_string]) {
      return;
    }
    var user = this._agoraUserMap[uid_string];
    var client = this._audioPublishers[uid_string];
    this._audioSubscriptions[uid_string] = client;
    var that = this;
    await client.subscribe(user, 'audio').then(response => {
      user.audioTrack.play();
      that.resolvePendingMediaRequestForTrack(user.uid, user.audioTrack._mediaStreamTrack);
      that.emit("stream_updated", user.uid, 'audio');
      console.info(" subscribe audio to "+user.uid);
    }).catch(e => {
      delete that._audioSubscriptions[uid_string];
      console.error(e);
    });
  }

  async removeAudioSubsIfNotExpected(expected) {
    var that = this;
    Object.keys(this._audioSubscriptions).forEach(async function (key) {
      if (!expected[key]) {
        var user = that._agoraUserMap[key];
        var client = that._audioSubscriptions[key];
        if (user && client) {
          console.info(" unsubscribe audio to " + key)
          await client.unsubscribe(user,'audio');
        }
        delete that._audioSubscriptions[key];
      }
    });
  }

  async addVideoSubsIfNotExisting(expected) {
    Object.keys(expected).forEach(peerId => this.addVideoSubIfNotExisting(peerId))
  }

  async addVideoSubIfNotExisting(uid_string) {
    if (this._videoSubscriptions[uid_string]) {
      return;
    }
    var user = this._agoraUserMap[uid_string];
    var client = this._videoPublishers[uid_string];
    this._videoSubscriptions[uid_string] = client;
    var that = this;
    await client.subscribe(user, 'video').then(response => {
      //console.info(" subscribe video to " + user.uid)
      that.resolvePendingMediaRequestForTrack(user.uid, user.videoTrack._mediaStreamTrack);
      that.emit("stream_updated", user.uid, 'video');
    }).catch(e => {
      delete that._videoSubscriptions[uid_string];
      console.error(e);
    });
  }

  async removeVideoSubsIfNotExpected(expected) {
    var that = this;
    Object.keys(this._videoSubscriptions).forEach(async function (key) {
      if (!expected[key]) {
        var user = that._agoraUserMap[key];
        var client = that._videoSubscriptions[key];
        if (user && client) {
          //console.info(" unsubscribe video to " + key)
          await client.unsubscribe(user,'video');
        }
        delete that._videoSubscriptions[key];
      }
    });
  }

  async manageSubscriptions() {
    try {
      // pre
      var _monitorStart = Date.now();
      this._manageSubscriptions();
      var _monitorEnd = Date.now();
      if (_monitorEnd - _monitorStart > this.processSubscriptonsAfter / 2) {
        console.warn("agora sub manage time took ", (_monitorEnd - _monitorStart));
      }
      // post
    } catch (e) {
      console.error(" manageSubscriptions ", e);
    }

    setTimeout(() => { this.manageSubscriptions() }, this.processSubscriptonsAfter);
  }

  async listAudioSourcesByOwner() {
    let audioSources = [];
    if (AFRAME.scenes[0]) {
       AFRAME.scenes[0].querySelectorAll("[avatar-audio-source]").forEach(async source => {
         audioSources.push((await NAF.utils.getNetworkedEntity(source)).components.networked.data.owner);
       });
    }
    return audioSources;
  }

  async _manageSubscriptions() {

    var expectedAudioSubs = {};
    var expectedVideoSubs = {};
    var audioSubs = 0;
    var videoSubs = 0;

      // get admins who are publishing
      // get all recent speakers
      // get remaining speakers by distance
      // get remaining audio publishers by distance

      // lots of talkers?
      // more than 8 talkers in list? sort them by distance and get 8 closest who may not have spoken recently (not ideal)
      // sort them by last spoke and hear remote people quietly (ideal)
      // if lots of people have spoken recently then we just want those closest
    
    // only check distances when more users than slots
    if (AFRAME.scenes[0] && this.limitSubscriptions  && (this._audioPubCount > this.maxAudioSubscriptions || this._videoPubCount > this.maxVideoSubscriptions || this.maxAudioDistanceApart > 0 || this.maxVideoDistanceApart > 0)) {
      const tmpWorldPos = new THREE.Vector3();
      let self = AFRAME.scenes[0].querySelector("a-entity#avatar-rig").object3D;
      let others = AFRAME.scenes[0].querySelectorAll("[avatar-audio-source]");
      let distances = [];
      
      // find distances 
      for (var u = 0; u < others.length; u++) {
        const peerId = await this.getOwnerId(others[u]);
        others[u].object3D.getWorldPosition(tmpWorldPos)
        var distance = self.position.distanceTo(tmpWorldPos);
        distances.push({ distance: distance, peerId: peerId });
      }
      distances.sort((a, b) => a.distance - b.distance);

      // ** Audio subscriptions ** 
      // get admins who are publishing at any distance
      if (this.prioritiseAdmins) {
        Object.keys(this._adminUsers).forEach(peerId => 
          {  
            if (this._audioPublishers[peerId] && audioSubs <  this.maxAudioSubscriptions ){
              audioSubs++;
              expectedAudioSubs[peerId] = peerId;
             // console.log("admin  ",peerId);
            }
          }
        )
      }
     
      if (this.enableVADControl) {
         // get all recent speakers within distance limit if set
        this._vadPublisherRecentByPriority.forEach(peerId => 
          {  // check within distance 
            if (!expectedAudioSubs[peerId] && this._audioPublishers[peerId] && audioSubs <  this.maxAudioSubscriptions ) {
              audioSubs++;
              expectedAudioSubs[peerId] = peerId;
            //  console.log("recent speak ",peerId);
            }
          }
        )
        
        // get remaining speakers by distance and within distance limits if set
        for (var d = 0; (d < distances.length && audioSubs < this.maxAudioSubscriptions); d++) {
          var peerId = distances[d].peerId;
          if (!expectedAudioSubs[peerId] && this._audioPublishers[peerId] &&  this._vadPublisherByPriority.indexOf(peerId) > -1 && (this.maxAudioDistanceApart <= 0 || distances[d].distance < this.maxAudioDistanceApart)) {
            audioSubs++;
            expectedAudioSubs[peerId] = peerId;
           // console.log("speak ",peerId);
          }
        }
      }

      // get remaining publishers by distance
      for (var d = 0; (d < distances.length && audioSubs < this.maxAudioSubscriptions); d++) {
        var peerId = distances[d].peerId;
        if (this._audioPublishers[peerId] && !expectedAudioSubs[peerId] && (this.maxAudioDistanceApart <= 0 || distances[d].distance < this.maxAudioDistanceApart)) {
          audioSubs++;
          expectedAudioSubs[peerId] = peerId;
         // console.log("remain ",peerId);
        }
      }

      // ** Video Subscriptions **       
      // get admins who are publishing at any distance
      if (this.prioritiseAdmins) {
        Object.keys(this._adminUsers).forEach(peerId => 
          {  
            if (this._videoPublishers[peerId] && videoSubs <  this.maxVideoSubscriptions ){
              videoSubs++;
              expectedVideoSubs[peerId] = peerId;
            }
          }
        )
      }
      
      for (var d = 0; (d < distances.length && videoSubs < this.maxVideoSubscriptions); d++) {
        var peerId = distances[d].peerId;
        if (this._videoPublishers[peerId] && !expectedVideoSubs[peerId] && (this.maxVideoDistanceApart <= 0 || distances[d].distance < this.maxVideoDistanceApart)) {
          videoSubs++;
          expectedVideoSubs[peerId] = peerId;
        }
      }

    console.log("audioSubs ",audioSubs, "audioExpect ",Object.keys(expectedAudioSubs).length, "audioPubs ", Object.keys(this._audioPublishers).length,"videoSubs ",videoSubs, "videoExpected ",Object.keys(expectedVideoSubs).length,  "videoPubs ", Object.keys(this._videoPublishers).length, "audioExpected ",Object.keys(expectedAudioSubs));
    } else {
      // copy all subs to expected 
      expectedAudioSubs = this._audioPublishers;
      expectedVideoSubs = this._videoPublishers;
    }


    // sync subscriptions
    this.addAudioSubsIfNotExisting(expectedAudioSubs);
    this.removeAudioSubsIfNotExpected(expectedAudioSubs);

    this.addVideoSubsIfNotExisting(expectedVideoSubs);
    this.removeVideoSubsIfNotExpected(expectedVideoSubs);

    // play the audio stream directly of any audio subscriptions with no audio source
    let audioSources = (await this.listAudioSourcesByOwner());
    Object.keys(expectedAudioSubs).forEach((subscription_uid) => {
      let user = this.getAgoraUser(subscription_uid);
      if (user && user.audioTrack) {
        if (!audioSources.includes(subscription_uid)) {
          user.audioTrack.play();
          console.info("play audio directly ", subscription_uid, user.audioTrack);
        } else if (user.audioTrack._played) {
          user.audioTrack.stop();
          console.info("end play audio directly ", subscription_uid, user.audioTrack);
        }
      }
    });
  }

  async getOwnerId(el) {
    const networkedEl = await NAF.utils.getNetworkedEntity(el).catch(e => {
      console.error(INFO_INIT_FAILED, INFO_NO_NETWORKED_EL, e);
    });
    if (!networkedEl) {
      return null;
    }
    return networkedEl.components.networked.data.owner;
  }

  // Agora RTM with VAD Control
  initRTM() {
    this.rtmClient = AgoraRTM.createInstance(this.appId, { logFilter: AgoraRTM.LOG_FILTER_OFF });
    this.rtmClient.on('ConnectionStateChanged', (newState, reason) => {
    });

    this.rtmClient.on('MessageFromPeer', ({ text }, senderId) => {
      this.receiveRTM(senderId, text);
    });

    this.rtmClient.login({ token: null, uid: this.rtmUid }).then(() => {
      this.rtmChannel = this.rtmClient.createChannel(this.rtmChannelName);
      this.rtmChannel.join().then(() => {
        console.warn("RTM joined");
        this.rtmChannel.on('ChannelMessage', ({ text }, senderId) => {
          this.receiveRTM(senderId, text);
        });
      }).catch(error => {
        console.warn('AgoraRTM client join failure', error);
      });
    }).catch(error => {
      console.warn('AgoraRTM client login failure', error);
    });
  }

  receiveRTM(senderId, text) {
    if (text.startsWith(this.VAD)) {
      var vadUid = text.split(":")[1];
      //console.warn("VAD received " + vadUid);

      if (this._vadPublisherByPriority.indexOf(vadUid) < 0) {
        this._vadPublisherByPriority.push(vadUid);
      }
      while (this._vadPublisherByPriority.length > this.maxAudioSubscriptions * 2) { // keep more in case some leave
        this._vadPublisherByPriority.shift();
      }

      // very recently spoke
      if (this._vadPublisherRecentByPriority.indexOf(vadUid) < 0) {
        this._vadPublisherRecentByPriority.push(vadUid);
      }
      while (this._vadPublisherRecentByPriority.length > this.maxAudioSubscriptions) { // keep more in case some leave
        this._vadPublisherRecentByPriority.shift();
      }
    }
    else if (text.startsWith(this.NoVAD)) {
      var vadUid = text.split(":")[1];

      this.removeUidFromArray(this._vadPublisherByPriority, vadUid);      
      //console.warn("No VAD received " + vadUid);
    }
  }

  sendVADEvent() {
    if (!this.rtmChannel) {
      return;
    }
    if ((Date.now() - this.vadSend) > this.vadSendWait) {
      this.vadSend = Date.now();
      this.rtmChannel.sendMessage({ text: this.VAD + ':' + this._clientId }).then(() => {
        //console.log("sent VAD ");
      }).catch(error => {
        console.error('AgoraRTM VAD send failure');
      });
    }
  }

  sendNoVADEvent() {
    if (!this.rtmChannel) {
      return;
    }
    this.rtmChannel.sendMessage({ text: this.NoVAD + ':' + this._clientId }).then(() => {
      //console.log("sent No VAD ");
    }).catch(error => {
      console.error('AgoraRTM VAD send failure');
    });
  }

  getInputLevel(track) {

    var analyser;
    if (track._source.volumeLevelAnalyser && track._source.volumeLevelAnalyser.analyserNode && track._source.volumeLevelAnalyser.analyserNode.frequencyBinCount) {
        analyser=track._source.volumeLevelAnalyser.analyserNode;
    } else if (track._source.analyserNode && track._source.analyserNode.frequencyBinCount) {
        analyser=track._source.analyserNode;
    } else {
        return 0;
    }

    const bufferLength = analyser.frequencyBinCount;
    var data = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(data);
    var values = 0;
    var average;
    var length = data.length;
    for (var i = 0; i < length; i++) {
      values += data[i];
    }
    average = Math.floor(values / length);
    return average;
  }

  voiceActivityDetection() {
    if (!this.localTracks || !this.localTracks.audioTrack || !this.localTracks.audioTrack._enabled)
      return;

    var audioLevel = this.getInputLevel(this.localTracks.audioTrack);
    if (audioLevel <= this._vad_MaxBackgroundNoiseLevel) {
      if (this._vad_audioSamplesArr.length >= this._vad_MaxAudioSamples) {
        var removed = this._vad_audioSamplesArr.shift();
        var removedIndex = this._vad_audioSamplesArrSorted.indexOf(removed);
        if (removedIndex > -1) {
          this._vad_audioSamplesArrSorted.splice(removedIndex, 1);
        }
      }
      this._vad_audioSamplesArr.push(audioLevel);
      this._vad_audioSamplesArrSorted.push(audioLevel);
      this._vad_audioSamplesArrSorted.sort((a, b) => a - b);
    }
    var background = Math.floor(3 * this._vad_audioSamplesArrSorted[Math.floor(this._vad_audioSamplesArrSorted.length / 2)] / 2);
    if (audioLevel > background + this._vad_SilenceOffeset) {
      this._vad_exceedCount++;
    } else {
      this._vad_exceedCount = 0;
    }

    if (this._vad_subceedCount > 0) {
      if (audioLevel < background + this._vad_SubceedOffeset) {
        this._vad_subceedCount--;
      }
      else if (audioLevel > background + this._vad_SilenceOffeset) {
        this._vad_subceedCount = this._vad_subceedCountBegin;
      } else if (this._vad_subceedCount < this._vad_subceedCountBegin) {
        this._vad_subceedCount++;
      }
    }

    if (this._vad_exceedCount > this._vad_exceedCountThreshold) {
      this._vad_exceedCount = 0;
      this._vad_subceedCount = this._vad_subceedCountBegin;
      this.sendVADEvent();
    }

    if (this._vad_subceedCount == 0) {
      this._vad_subceedCount = -1;
      this.sendNoVADEvent();
    }

  //  console.log("audioLevel", audioLevel, "background + 10 ", background + this._vad_SilenceOffeset, "_vad_exceedCount", this._vad_exceedCount, "_vad_audioSamplesArr length", this._vad_audioSamplesArr.length, "_vad_subceedCount", this._vad_subceedCount);
  }



}

