// Test-only alternate entry point. Calls the real product validators with
// synthetic inputs; it is not an OS identity or live pipe positive test.
using System;
using System.Collections.Generic;
partial class WindowsOwnerBootstrap {
  internal static int PurposeCodec(){
    try{
      var input=Parse(ParentLine());var policy=(Dictionary<string,object>)input["policy"];
      if(Str(input,"phase")=="policy")Policy(policy,(bool)input["server"],(Dictionary<string,object>)input["self"]);
      else{string phase=Str(input,"phase");Message((Dictionary<string,object>)input["frame"],policy,Operation(policy,phase),Str(input,"challenge"),phase=="result",Str(input,"expectedNonce"));}
      Emit(new{kind="accepted"});return 0;
    }catch(Exception error){Emit(new{kind="error",code=error is InvalidOperationException&&error.Message.StartsWith("OBC_")?error.Message:"OBC_CODEC_FAILED"});return 1;}
  }
}
static class OwnerPurposeCodecMain {public static int Main(){return WindowsOwnerBootstrap.PurposeCodec();}}
