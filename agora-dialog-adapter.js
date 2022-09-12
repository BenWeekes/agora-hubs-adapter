import AgoraRTC  from 'agora-rtc-sdk-ng';
import VirtualBackgroundExtension from 'agora-extension-virtual-background';
import { debug as newDebug } from "debug";
import EventEmitter from "eventemitter3";
import {getParameterByName, getParameterByNameInt} from "./utils/media-url-utils";


const debug = newDebug("agora-dialog-adapter:debug");
const error = newDebug("agora-dialog-adapter:error");
const info = newDebug("agora-dialog-adapter:info");

export const DIALOG_CONNECTION_CONNECTED = "dialog-connection-connected";
export const DIALOG_CONNECTION_ERROR_FATAL = "dialog-connection-error-fatal";

export class DialogAdapter extends EventEmitter {
  constructor() {
    super();
    this._micShouldBeEnabled = false;
    this._localMediaStream = null;
    this._pendingMediaRequests = new Map();
    this._blockedClients = new Map();
    this.scene = null;
    this._serverParams = {};
    this._consumerStats = {};
    this._agora_client = null;

    // If your Agora appId has tokens enabled then you can set a tokenAPI URL below to request a token
    // To quickly run an AWS Lambda token service see https://github.com/BenWeekes/agora-rtc-lambda
    // set Agora appId here
    this.appId = "0eb825fdf2e04792a458f86b259f95d7"; 
    // set token server if tokens are enabled
    this.tokenAPI="https://24volagzyvl2t3cziyxhiy7kpy0tdzke.lambda-url.us-east-1.on.aws/?channel="; 
    this.virtualBackgroundInstance = null;
    this.extension = null;
    this.processor = null;
    this.userid = null;

    this.localTracks = {
      videoTrack: null,
      audioTrack: null
    };
  }

  // public
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
      console.info("user-joined "+ user.uid);
    });

    this._agora_client.on("user-published", async (user, mediaType) => {
      let clientId = user.uid;
      await that._agora_client.subscribe(user, mediaType);
      if (mediaType === 'audio') {
        that.resolvePendingMediaRequestForTrack(clientId, user.audioTrack._mediaStreamTrack);
      } else if (mediaType === 'video') {
        that.resolvePendingMediaRequestForTrack(clientId, user.videoTrack._mediaStreamTrack);
      }
      that.emit("stream_updated", clientId, mediaType);
    });

    this._agora_client.on("user-unpublished", async (user, mediaType) => {
      let clientId = user.uid;
      that.closeRemote(clientId);
    });


    return new Promise((resolve, reject) => {
      (async () => {
      try {
        await this._joinRoom();
        resolve();
        this.emit(DIALOG_CONNECTION_CONNECTED);
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
    if (this.tokenAPI!==null) {
      let token_api=this.tokenAPI+this._roomId+"&uid="+this._clientId;
      try {
        const respJson = await fetch(`${token_api}`).then(r => r.json());
        let uid = respJson.uid;
        let token = respJson.token;
        alert(uid+token);
        await this._agora_client.join(this.appId, this._roomId, token, this._clientId);
    } catch (e) {
      console.error("Error fetching whats-new", e);
    }
  } else {
    await this._agora_client.join(this.appId, this._roomId, null, this._clientId);
  }

    
    await this.setLocalMediaStream(this._localMediaStream);
  }

  // private
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

  // private
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
    for (var u=0; u< this._agora_client._users.length; u++ )
    {
     if (this._agora_client._users[u].uid==clientId) {
      return this._agora_client._users[u];
     }
    }
    return null;
  }

  // public - returns promise 
  getMediaStream(clientId, kind = "audio") {
    let track;
    if (this._clientId === clientId) {
      // LOCAL USER
      if (kind === "audio" &&  this.localTracks.audioTrack) {
        track = this.localTracks.audioTrack._mediaStreamTrack;
      } else if (kind === "video" && this.localTracks.videoTrack) {
        track = this.localTracks.videoTrack._mediaStreamTrack;
      }
    } else { 
      // REMOTE USERS
      let user=this.getAgoraUser(clientId);
      if (user && kind === "audio" &&  user.audioTrack && user.audioTrack._mediaStreamTrack) {
        track =  user.audioTrack._mediaStreamTrack;
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
          this.localTracks.audioTrack=await AgoraRTC.createCustomAudioTrack({
            mediaStreamTrack: stream.getAudioTracks()[0]
          });
          if (this.isMicEnabled()) {
            this.emit("mic-state-changed", { enabled: true });
            await this._agora_client.publish( this.localTracks.audioTrack);
          }
        } else if (track.kind === "video") {
          this.localTracks.videoTrack=await AgoraRTC.createCustomVideoTrack({
            mediaStreamTrack: stream.getVideoTracks()[0], bitrateMin: getParameterByNameInt("bitrateMin",600), bitrateMax: getParameterByNameInt("bitrateMax",1500) , optimizationMode: 'motion'
          });
          if (this.localTracks &&this.localTracks.videoTrack) {
            await this._agora_client.publish( this.localTracks.videoTrack);
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
      enabled=false;
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
}

