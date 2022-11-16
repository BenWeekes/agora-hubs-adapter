# agora-hubs-adapter   

To use Agora's low latency, high quality, scalable Voice and Video (https://www.agora.io/en/) with your hubs-cloud instance do the following:   


##  Integration           


Add these dependencies to package.json and run npm ci      

 "agora-rtc-sdk-ng": "4.13.0",     
 "agora-rtm-sdk": "1.6.0-204",

Copy agora-dialog-adapter.js from this repo to hubs/src (i.e. the same location as naf-dialog-adatar.js)    

Change the import statements in src/hubs.js from    
import { DialogAdapter, DIALOG_CONNECTION_ERROR_FATAL, DIALOG_CONNECTION_CONNECTED } from "./naf-dialog-adapter";    
to    
import { DialogAdapter, DIALOG_CONNECTION_ERROR_FATAL, DIALOG_CONNECTION_CONNECTED } from "./agora-dialog-adapter";            

If you are using tokens with your Agora AppID please see     
https://github.com/BenWeekes/agora-rtc-lambda     

Set your AppID (and optional token server url) in agora-dialog-adapter.js       

Your hubs client will now use your Agora account for high quality, low latency voice and video.     

Agora provides much higher quality and lower latency voice and video calls compared with public internet, peer to peer, single SFU model.

## Code Configurations      
The following variables can be changed the top of the adapter to provide more control over the experience as described in the comment.     

    this.limitSubscriptions = true;  // set to false to always subscribe to all available streams (or the host limit of your appid which has a default of 16).    
    this.maxAudioSubscriptions = 6;  // when more than this number of publishers are available then only the closest X neighbours will be subscribed to.     
    this.maxAudioDistanceApart = -1;  // only subscribe to audio of people within this distance in hubs scene (in any direction)  or set to -1 for no limit.      
    this.maxVideoSubscriptions = 6;  // when more than this number of publishers are available then only the closest X neighbours will be subscribed to.     
    this.maxVideoDistanceApart = -1;  // only subscribe to video of people within this distance in hubs scene (in any direction) or set to -1 for no limit.      
    this.processSubscriptonsAfter = 300; // time between subsequent subscription processes in ms (recommended 300 ms).    
    this.channelCount = 5; // default 5, increase to allow more Agora channels to be used in parallel
    this.maxHostsPerChannel = 16; // default 16, number of hosts in Agora channel
    this.prioritiseAdmins = true; // treat admins as zero distance when deciding who to subscribe to
    this.enableVADControl = true; // take voice detection into account when prioritising     
    
    Using the above there will be 6 audio subscriptions at any time prioritised by isAdmin, isTalking, distance.    
    



## Content Security Policy
Extra Content Security Policy connect-src Rules for your hubs cloud service onfiguration:  

  https://*.agora.io  https://*.sd-rtn.com wss://.agora.io  wss://.sd-rtn.com wss://.edge.sd-rtn.com:4702  wss://.edge.sd-rtn.com  wss://.edge.sd-rtn.com: wss://.edge.agora.io wss://.edge.agora.io:*
