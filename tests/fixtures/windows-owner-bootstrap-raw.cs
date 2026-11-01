// Test-only partial extension, compiled with /main:OwnerBootstrapRawMain.
// Never shipped or accepted as a mode by the product helper.
using System;
using System.Collections.Generic;
using System.Threading;
partial class WindowsOwnerBootstrap {
  internal static int RawProbe(){
    var timer=new Timer(_=>Environment.Exit(2),null,12000,Timeout.Infinite);
    try{
      var input=Parse(ParentLine());var policy=(Dictionary<string,object>)input["policy"];string fault=Str(input,"fault");
      PermitPeerQuery(Str(policy,"controlSid"));
      using(var pipe=Client(Str(policy,"pipeName"))){
        Dictionary<string,object> facts;using(var peer=Pin(pipe,false,(Dictionary<string,object>)policy["peer"],out facts)){
          var frame=Parse(ReadFrame(pipe));frame["operation"]=Operation(policy,"request");
          bool v2=Version(policy)==2;if(v2)frame["launchNonce"]=Str(policy,"launchNonce");
          if(fault=="instance")frame["instanceId"]="00000000-0000-0000-0000-000000000000";
          else if(fault=="request")frame["requestId"]=new string('0',32);
          else if(fault=="nonce")frame["challenge"]=new string('x',43);
          else if(fault=="operation")frame["operation"]="run.execute";
          else if(fault=="claimed-sid")frame["sid"]=Str(policy,"ownerSid");
          else if(fault=="extend")frame["expiresAtUnixMs"]=Num(policy,"expiresAtUnixMs")+1000;
          else if(fault=="purpose")frame["operation"]=Str(policy,"purpose")=="browser"?"owner.cli":"owner.browser";
          else if(fault=="downgrade")frame["version"]=1;
          else if(fault=="launch-missing")frame.Remove("launchNonce");
          else if(fault=="launch-invalid")frame["launchNonce"]=new string('x',64);
          else if(fault=="disconnect"){Emit(new{kind="disconnected"});return 0;}
          else if(fault!="replay"&&fault!="delivery-failure"&&fault!="receipt-nonce"&&fault!="receipt-purpose")throw new InvalidOperationException("OBC_FIXTURE_INVALID");
          WriteFrame(pipe,Json.Serialize(frame));if(fault=="replay")WriteFrame(pipe,Json.Serialize(frame));
          var result=Parse(ReadFrame(pipe));Emit(new{kind="result",outcome=result,facts=facts});
          if(v2){
            // Test-only parent holds the pipe while it exchanges the ticket via
            // actual HTTP. No ticket is written to the QA handoff directory.
            var release=Parse(ParentLine());Require(release.Count==1&&release.ContainsKey("release")&&release["release"] is bool&&(bool)release["release"],"OBC_FIXTURE_INVALID");
            if(fault=="delivery-failure")return 0;
            var receipt=new Dictionary<string,object>(frame);receipt["operation"]=Operation(policy,"receipt");
            if(fault=="receipt-nonce")receipt["launchNonce"]=new string('f',64);
            if(fault=="receipt-purpose")receipt["operation"]="owner.cli.receipt";
            WriteFrame(pipe,Json.Serialize(receipt));
          }
        }
      }
      return 0;
    }catch(Exception error){Emit(new{kind="error",code=error is InvalidOperationException&&error.Message.StartsWith("OBC_")?error.Message:"OBC_TRANSPORT_FAILED"});return 1;}
    finally{timer.Dispose();}
  }
}
static class OwnerBootstrapRawMain {public static int Main(){return WindowsOwnerBootstrap.RawProbe();}}
