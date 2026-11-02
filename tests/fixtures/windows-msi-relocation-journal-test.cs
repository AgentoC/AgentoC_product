using System;
using System.IO;
using System.Linq;
using System.Text;

internal static class OwnerMsiRelocationJournalTest {
 static void Check(bool value,string message){if(!value)throw new Exception(message);}
 public static int Main(string[] args){
  try{
   string root=Path.GetFullPath(args[0]);
   for(int fault=1;fault<=OwnerMsiRelocationJournal.ReceiptNames.Length;fault++){
    string source=Path.Combine(root,"source-"+fault),target=Path.Combine(root,"target-"+fault);
    Directory.CreateDirectory(source);Directory.CreateDirectory(target);
    foreach(string name in OwnerMsiRelocationJournal.ReceiptNames)File.WriteAllText(Path.Combine(source,name),"source-"+name,Encoding.UTF8);
    foreach(string name in OwnerMsiRelocationJournal.ReceiptNames.Skip(1))File.WriteAllText(Path.Combine(target,name),"previous-"+name,Encoding.UTF8);
    File.WriteAllText(Path.Combine(target,"unrelated.txt"),"keep",Encoding.UTF8);
    try{OwnerMsiRelocationJournal.Begin(source,target,fault);throw new Exception("Expected injected failure");}
    catch(InvalidOperationException e){Check(e.Message=="OMR_TEST_FAILURE","unexpected failure "+e.Message);}
    string partialPath=null;
    if(fault==1){
     string backup=Directory.GetDirectories(target,"owner-msi.relocation-backup-*").Single();
     string next=OwnerMsiRelocationJournal.ReceiptNames[1];
     File.Move(Path.Combine(target,next),Path.Combine(backup,next));
     partialPath=Path.Combine(backup,next+".incoming");
     File.WriteAllText(partialPath,"partial-write",Encoding.UTF8);
    }
    OwnerMsiRelocationJournal.Rollback(target);
    Check(!File.Exists(Path.Combine(target,OwnerMsiRelocationJournal.ReceiptNames[0])),"new marker remains");
    foreach(string name in OwnerMsiRelocationJournal.ReceiptNames.Skip(1))
     Check(File.ReadAllText(Path.Combine(target,name),Encoding.UTF8)=="previous-"+name,"previous marker changed");
    foreach(string name in OwnerMsiRelocationJournal.ReceiptNames)
     Check(File.ReadAllText(Path.Combine(source,name),Encoding.UTF8)=="source-"+name,"source changed");
    Check(File.ReadAllText(Path.Combine(target,"unrelated.txt"),Encoding.UTF8)=="keep","unrelated file changed");
    Check(!File.Exists(Path.Combine(target,"owner-msi.relocation.json")),"journal remains");
    if(partialPath!=null)Check(File.ReadAllText(partialPath,Encoding.UTF8)=="partial-write","partial data must be preserved");
   }
   string sourceTamper=Path.Combine(root,"source-tamper"),targetTamper=Path.Combine(root,"target-tamper");
   Directory.CreateDirectory(sourceTamper);Directory.CreateDirectory(targetTamper);
   foreach(string name in OwnerMsiRelocationJournal.ReceiptNames)File.WriteAllText(Path.Combine(sourceTamper,name),"source-"+name,Encoding.UTF8);
   foreach(string name in OwnerMsiRelocationJournal.ReceiptNames.Skip(1))File.WriteAllText(Path.Combine(targetTamper,name),"previous-"+name,Encoding.UTF8);
   try{OwnerMsiRelocationJournal.Begin(sourceTamper,targetTamper,1);}catch(InvalidOperationException){}
   string changed=Path.Combine(targetTamper,OwnerMsiRelocationJournal.ReceiptNames[0]);
   File.WriteAllText(changed,"unexpected content",Encoding.UTF8);
   try{OwnerMsiRelocationJournal.Rollback(targetTamper);throw new Exception("Unexpected modified file was accepted");}
   catch(InvalidOperationException error){Check(error.Message=="OMR_TARGET_CHANGED","wrong refusal "+error.Message);}
   Check(File.ReadAllText(changed,Encoding.UTF8)=="unexpected content","modified file was overwritten");
   Check(File.Exists(Path.Combine(targetTamper,"owner-msi.relocation.json")),"refused rollback must retain journal");
   Console.WriteLine("PASS: recovery receipts roll back after each injected failure and preserve source and unrelated files");
   return 0;
  }catch(Exception error){Console.Error.WriteLine(error.ToString());return 1;}
 }
}
