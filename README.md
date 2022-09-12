# agora-hubs-adapter   

To use Agora Voice and Video with your own instance of hubs-cloud do the following:   

Copy agora-dialog-adapter.js from this repo to hubs/src (i.e. the same location as naf-dialog-adatar.js)    

Change the import statements in src/hubs.js from    
import { DialogAdapter, DIALOG_CONNECTION_ERROR_FATAL, DIALOG_CONNECTION_CONNECTED } from "./naf-dialog-adapter";    
to    
import { DialogAdapter, DIALOG_CONNECTION_ERROR_FATAL, DIALOG_CONNECTION_CONNECTED } from "./agora-dialog-adapter";            

If you are using tokens with your Agora AppID please see     
https://github.com/BenWeekes/agora-rtc-lambda     


Set your appid (and optional token server url) in agora-dialog-adapter.js       

Your hubs client will now be using your Agora account for high quality, low latency voice and video

