# agora-hubs-adapter   

To use Agora's Voice and Video (https://www.agora.io/en/) with your hubs-cloud instance do the following:   

Add this dependency (or more recent version) to package.json and run npm ci      

 "agora-rtc-sdk-ng": "4.13.0",     

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



