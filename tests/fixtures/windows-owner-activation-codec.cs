using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;
partial class WindowsOwnerBootstrap {
 public static int ActivationCodec(){try{
  var input=Parse(Console.ReadLine());var policy=(Dictionary<string,object>)input["policy"];
  if(Str(input,"phase")=="policy")ActivationPolicy(policy,(bool)input["server"],(Dictionary<string,object>)input["self"]);
  else ActivationFrame((Dictionary<string,object>)input["frame"],policy,Str(input,"phase"),input.ContainsKey("original")?(Dictionary<string,object>)input["original"]:null);
  Emit(new{kind="accepted"});return 0;
 }catch(Exception error){Emit(new{kind="error",code=error.Message});return 1;}}
}
class OwnerActivationCodecMain {public static int Main(){return WindowsOwnerBootstrap.ActivationCodec();}}
