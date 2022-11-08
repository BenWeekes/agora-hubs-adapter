import AgoraRTC from 'agora-rtc-sdk-ng';
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

    this._agora_client = null;
    this._agoraUserMap = {};
    this.localTracks = {
      videoTrack: null,
      audioTrack: null
    }

    this._videoSubscriptions = {};
    this._audioSubscriptions = {};
    this._videoPublishers = {};
    this._audioPublishers = {};
    this._audioPubCount = 0; 
    this._videoPubCount = 0;
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
    this._agora_client = AgoraRTC.createClient({ codec: 'vp8', mode: 'rtc', });
    var that = this;

    this._agora_client.on("user-joined", async (user) => {
      console.info("user-joined " + user.uid);
    });

    this._agora_client.on("user-published", async (user, mediaType) => {
      var uid_string = user.uid.toString();
      that._agoraUserMap[uid_string] = user;
      if (mediaType === 'audio') {
        that._audioPublishers[uid_string] = user;
        this._audioPubCount = this.getMapSize(this._audioPublishers);
      } else if (mediaType === 'video') {
        that._videoPublishers[uid_string] = user;
        this._videoPubCount = this.getMapSize(this._videoPublishers);
      }
    });

    this._agora_client.on("user-unpublished", async (user, mediaType) => {
      var uid_string = user.uid.toString();
      if (mediaType === 'audio') {
        delete that._audioPublishers[uid_string];
        this._audioPubCount = this.getMapSize(this._audioPublishers);
      } else if (mediaType === 'video') {
        delete that._videoPublishers[uid_string];
        this._videoPubCount = this.getMapSize(this._videoPublishers);
      }
    });

    this._agora_client.on("user-left", async (user, mediaType) => {
      var uid_string = user.uid.toString();
      delete that._agoraUserMap[uid_string];
      delete that._audioPublishers[uid_string];
      this._audioPubCount = this.getMapSize(this._audioPublishers);
      delete that._videoPublishers[uid_string];
      this._videoPubCount = this.getMapSize(this._videoPublishers);

      that.closeRemote(uid_string);
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
      let token_api = this.tokenAPI + this._roomId + "&uid=" + this._clientId;
      try {
        const respJson = await fetch(`${token_api}`).then(r => r.json());
        //let uid = respJson.uid;
        let token = respJson.token;
        await this._agora_client.join(this.appId, this._roomId, token, this._clientId);
      } catch (e) {
        console.error("Error fetching/using Agora Token ", e);
        return;
      }
    } else {
      try {
        await this._agora_client.join(this.appId, this._roomId, null, this._clientId);
      } catch (e) {
        console.error("Failed to join Agora ", e);
        return;
      }
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
  async setLocalMediaStream(stream) {
    await this._agora_client.unpublish();
    if (!stream) {
      return;
    }
    await Promise.all(
      stream.getTracks().map(async track => {
        if (track.kind === "audio") {
          this.localTracks.audioTrack = await AgoraRTC.createCustomAudioTrack({
            mediaStreamTrack: stream.getAudioTracks()[0]
          });
          if (this.isMicEnabled()) {
            this.emit("mic-state-changed", { enabled: true });
            await this._agora_client.publish(this.localTracks.audioTrack);
          }
        } else if (track.kind === "video") {
          this.localTracks.videoTrack = await AgoraRTC.createCustomVideoTrack({
            mediaStreamTrack: stream.getVideoTracks()[0], bitrateMin: 600, bitrateMax: 1500, optimizationMode: 'motion'
          });
          if (this.localTracks && this.localTracks.videoTrack) {
            await this._agora_client.publish(this.localTracks.videoTrack);
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
      this.enableMicrophone(false);
    } else {
      this.enableMicrophone(true);
    }
  }

  enableMicrophone(enabled) {
    if (!this.localTracks || !this.localTracks.audioTrack) {
      console.error("Tried to toggle mic but there's no mic.");
      enabled = false;
    } else {
      this.localTracks.audioTrack.setEnabled(enabled);
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


   async addAudioSubsIfNotExisting(expected) {
    Object.keys(expected).forEach(peerId => this.addAudioSubIfNotExisting(peerId))
   }

  async addAudioSubIfNotExisting(uid_string) {
    if (this._audioSubscriptions[uid_string]) {
      return;
    }
    var user = this._agoraUserMap[uid_string];
    var client = this._agora_client;
    this._audioSubscriptions[uid_string] = client;
    var that = this;
    await client.subscribe(user, 'audio').then(response => {
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
        var prom = await client.unsubscribe(user, that.AUDIO);
        console.info(" unsubscribe audio to "+key)
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
    var client = this._agora_client;
    this._videoSubscriptions[uid_string] = client;
    var that = this;
    await client.subscribe(user, 'video').then(response => {
      console.info(" subscribe video to "+user.uid)
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
        console.info(" unsubscribe video to "+key)
        var prom = await client.unsubscribe(user, that.VIDEO);
        delete that._videoSubscriptions[key];
      }
    });
  }

  async manageSubscriptions() {
    try {
      // pre
      var _monitorStart=Date.now();      
      this._manageSubscriptions();
      var _monitorEnd=Date.now();
      if (_monitorEnd-_monitorStart > this.processSubscriptonsAfter/2) {
        console.warn("agora sub manage time took ",(_monitorEnd-_monitorStart));
      }
      // post
    } catch (e) {
      console.error(" manageSubscriptions ", e);
    }

    setTimeout(() => {this.manageSubscriptions()}, this.processSubscriptonsAfter);
  }

  async _manageSubscriptions() {

    var expectedAudioSubs = {};
    var expectedVideoSubs = {};

    // only check distances when more users than slots
    if (this.limitSubscriptions && (this._audioPubCount>this.maxAudioSubscriptions || this._videoPubCount>this.maxVideoSubscriptions || this.maxAudioDistanceApart>0 || this.maxVideoDistanceApart>0) ) {
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

      var audioSubs=0;
      for (var d = 0; (d < distances.length && audioSubs<this.maxAudioSubscriptions); d++) {
        var peerId=distances[d].peerId;
        if (this._audioPublishers[peerId] && (this.maxAudioDistanceApart<=0 || distances[d].distance<this.maxAudioDistanceApart)) {
          audioSubs++;
          expectedAudioSubs[peerId] = peerId;
        //  console.log(" nearest " + peerId + " distance is "+distances[d].distance)
        }
      }

      var videoSubs=0;
      for (var d = 0; (d < distances.length && videoSubs<this.maxVideoSubscriptions); d++) {
        var peerId=distances[d].peerId;
        if (this._videoPublishers[peerId]  && (this.maxVideoDistanceApart<=0 || distances[d].distance<this.maxVideoDistanceApart) ) {
          videoSubs++;
          expectedVideoSubs[peerId] = peerId;
        }
      }
    } else {
      // copy all subs to expected 
      expectedAudioSubs=this._audioPublishers;
      expectedVideoSubs=this._videoPublishers;
    }

    // sync subscriptions
    this.addAudioSubsIfNotExisting(expectedAudioSubs);
    this.removeAudioSubsIfNotExpected(expectedAudioSubs);

    this.addVideoSubsIfNotExisting(expectedVideoSubs);
    this.removeVideoSubsIfNotExpected(expectedVideoSubs);
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
}
