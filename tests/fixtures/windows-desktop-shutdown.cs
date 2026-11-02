using System;
using System.Reflection;
public static class DesktopShutdownFixture {
 public static int Main(string[] args){
  try{typeof(ManagedOwnerMsiBridge).GetMethod("CloseProcessesForPath",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{args[0],false});return 0;}
  catch(Exception error){Console.Error.WriteLine(error.GetBaseException().Message);return 1;}
 }
}
