// Independent token observer and self-only negative privilege/integrity probe.
// Never installed in a product package, accepts no token/credential/command input.
using System;using System.Collections.Generic;using System.Diagnostics;
using System.Runtime.InteropServices;using System.Security.Principal;
using System.Text;using System.Web.Script.Serialization;
static class HostTokenProbe {
 [StructLayout(LayoutKind.Sequential)] struct SidAttributes{public IntPtr sid;public uint attrs;}
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int size,out int needed);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool AdjustTokenPrivileges(IntPtr token,bool all,IntPtr state,int size,IntPtr previous,IntPtr returned);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr buffer,int size);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool LookupPrivilegeName(string host,IntPtr luid,StringBuilder name,ref int length);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool LookupPrivilegeValue(string host,string name,IntPtr luid);
 static void Need(bool ok){if(!ok)throw new InvalidOperationException("TOKEN_PROBE_FAILED");}
 static IntPtr Info(IntPtr token,int kind){int size;GetTokenInformation(token,kind,IntPtr.Zero,0,out size);Need(size>0&&size<=65536);var data=Marshal.AllocHGlobal(size);if(!GetTokenInformation(token,kind,data,size,out size)){Marshal.FreeHGlobal(data);throw new InvalidOperationException("TOKEN_QUERY_FAILED");}return data;}
 static Dictionary<string,object> Facts(IntPtr process,int pid){
  IntPtr token;Need(OpenProcessToken(process,8,out token));
  try{
   string sid;int integrity,session;bool elevated,admin=false;var privileges=new List<string>();
   var data=Info(token,1);try{sid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;}finally{Marshal.FreeHGlobal(data);}
   data=Info(token,25);try{var label=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;integrity=int.Parse(label.Substring(label.LastIndexOf('-')+1));}finally{Marshal.FreeHGlobal(data);}
   data=Info(token,12);try{session=Marshal.ReadInt32(data);}finally{Marshal.FreeHGlobal(data);}
   data=Info(token,20);try{elevated=Marshal.ReadInt32(data)!=0;}finally{Marshal.FreeHGlobal(data);}
   data=Info(token,2);try{int count=Marshal.ReadInt32(data),offset=IntPtr.Size==8?8:4,stride=IntPtr.Size==8?16:8;Need(count>=0&&count<=1024);
    for(int i=0;i<count;i++){var entry=IntPtr.Add(data,offset+i*stride);int attributes=Marshal.ReadInt32(entry,IntPtr.Size);if((attributes&4)!=0&&(attributes&16)==0&&new SecurityIdentifier(Marshal.ReadIntPtr(entry)).Value=="S-1-5-32-544")admin=true;}
   }finally{Marshal.FreeHGlobal(data);}
   data=Info(token,3);try{int count=Marshal.ReadInt32(data);Need(count>=0&&count<=256);for(int i=0;i<count;i++){int length=256;var name=new StringBuilder(length);Need(LookupPrivilegeName(null,IntPtr.Add(data,4+i*12),name,ref length));privileges.Add(name.ToString());}}finally{Marshal.FreeHGlobal(data);}
   return new Dictionary<string,object>{{"pid",pid},{"sid",sid},{"integrityRid",integrity},{"sessionId",session},{"elevated",elevated},{"enabledAdministrators",admin},{"privileges",privileges}};
  }finally{CloseHandle(token);}
 }
 static bool CannotReenable(){
  IntPtr token;Need(OpenProcessToken(GetCurrentProcess(),8|32,out token));var state=Marshal.AllocHGlobal(16);
  try{Marshal.WriteInt32(state,1);Need(LookupPrivilegeValue(null,"SeImpersonatePrivilege",IntPtr.Add(state,4)));Marshal.WriteInt32(state,12,2);
   bool success=AdjustTokenPrivileges(token,false,state,0,IntPtr.Zero,IntPtr.Zero);int code=Marshal.GetLastWin32Error();return success&&code==1300;
  }finally{Marshal.FreeHGlobal(state);CloseHandle(token);}
 }
 static bool CannotRaise(){
  IntPtr token;Need(OpenProcessToken(GetCurrentProcess(),8|128,out token));var sid=new SecurityIdentifier("S-1-16-12288");var bytes=new byte[sid.BinaryLength];sid.GetBinaryForm(bytes,0);
  int size=Marshal.SizeOf(typeof(SidAttributes));var data=Marshal.AllocHGlobal(size+bytes.Length);
  try{var label=IntPtr.Add(data,size);Marshal.Copy(bytes,0,label,bytes.Length);Marshal.StructureToPtr(new SidAttributes{sid=label,attrs=32},data,false);
   bool raised=SetTokenInformation(token,25,data,size+bytes.Length);int code=Marshal.GetLastWin32Error();return !raised&&(code==5||code==1314);
  }finally{Marshal.FreeHGlobal(data);CloseHandle(token);}
 }
 public static int Main(string[] args){
  var json=new JavaScriptSerializer();IntPtr process=IntPtr.Zero;
  try{
   bool self=args.Length==1&&args[0]=="--self";Need(self||args.Length==1);int pid=self?Process.GetCurrentProcess().Id:int.Parse(args[0]);
   process=self?GetCurrentProcess():OpenProcess(0x1000,false,pid);Need(process!=IntPtr.Zero);var facts=Facts(process,pid);
   if(self){facts["privilegeReenableDenied"]=CannotReenable();facts["integrityRaiseDenied"]=CannotRaise();facts["postIntegrityRid"]=Facts(process,pid)["integrityRid"];}
   Console.WriteLine(json.Serialize(facts));return 0;
  }catch(Exception error){Console.WriteLine(json.Serialize(new{error=error.GetType().Name,pass=false}));return 1;}
  finally{if(process!=IntPtr.Zero&&process!=GetCurrentProcess())CloseHandle(process);}
 }
}
