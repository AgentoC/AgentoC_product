// A file-only recovery receipt transaction. The caller must validate and pin
// both administrator-owned directory trees and the retained Owner identity.
// This component never reads or modifies ProgramData or service credentials.
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class OwnerMsiRelocationJournal {
 internal static readonly string[] ReceiptNames = {
  "owner-msi.removed.json", "owner-msi.prepared.activated.json",
  "owner-msi.policy.activated.json", "owner-msi.activated.json",
  "owner-msi.activation-health.json", "owner-activation.committed-lock"
 };
 const string JournalName="owner-msi.relocation.json";
 const string BackupPrefix="owner-msi.relocation-backup-";
 static void Need(bool ok,string code){if(!ok)throw new InvalidOperationException(code);}
 static bool IsRegular(string path){
  if(!File.Exists(path))return false;
  var attributes=File.GetAttributes(path);
  Need((attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))==0,"OMR_FILE_UNSAFE");
  return true;
 }
 static string Hash(string path){
  Need(IsRegular(path),"OMR_FILE_MISSING");
  using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read))
  using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(f)).Replace("-","").ToLowerInvariant();
 }
 static string Text(Dictionary<string,object> obj,string key){
  Need(obj.ContainsKey(key)&&obj[key] is string,"OMR_JOURNAL_INVALID");return (string)obj[key];
 }
 static string BackupPath(string target,string id){
  Need(Regex.IsMatch(id,@"\A[a-f0-9]{32}\z"),"OMR_JOURNAL_INVALID");
  return Path.Combine(target,BackupPrefix+id);
 }
 static Dictionary<string,object> ReadJournal(string target){
  string path=Path.Combine(target,JournalName);Need(IsRegular(path),"OMR_JOURNAL_MISSING");
  string text=File.ReadAllText(path,new UTF8Encoding(false,true));Need(text.Length>0&&text.Length<=32768,"OMR_JOURNAL_INVALID");
  var j=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(text);
  Need(j!=null&&j.Count==4&&j.ContainsKey("version")&&j["version"] is int&&(int)j["version"]==1
   &&Text(j,"purpose")=="owner-msi-relocation"&&j.ContainsKey("entries"),"OMR_JOURNAL_INVALID");
  string id=Text(j,"id");string backup=BackupPath(target,id);
  Need(Directory.Exists(backup)&&(File.GetAttributes(backup)&FileAttributes.ReparsePoint)==0,"OMR_BACKUP_INVALID");
  var entries=j["entries"] as System.Collections.ArrayList;
  Need(entries!=null&&entries.Count==ReceiptNames.Length,"OMR_JOURNAL_INVALID");
  var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  foreach(object item in entries){
   var row=item as Dictionary<string,object>;Need(row!=null&&row.Count==3,"OMR_JOURNAL_INVALID");
   string name=Text(row,"name"),incoming=Text(row,"incoming"),previous=Text(row,"previous");
   Need(ReceiptNames.Contains(name,StringComparer.Ordinal)&&seen.Add(name)
    &&Regex.IsMatch(incoming,@"\A[a-f0-9]{64}\z")
    &&(previous==""||Regex.IsMatch(previous,@"\A[a-f0-9]{64}\z")),"OMR_JOURNAL_INVALID");
  }
  return j;
 }
 internal static void Begin(string source,string target,int failAfter){
  source=Path.GetFullPath(source).TrimEnd('\\');target=Path.GetFullPath(target).TrimEnd('\\');
  Need(!String.Equals(source,target,StringComparison.OrdinalIgnoreCase)
   &&!source.StartsWith(target+"\\",StringComparison.OrdinalIgnoreCase)
   &&!target.StartsWith(source+"\\",StringComparison.OrdinalIgnoreCase),"OMR_PATH_OVERLAP");
  Need(Directory.Exists(source)&&Directory.Exists(target),"OMR_DIRECTORY_MISSING");
  Need(!File.Exists(Path.Combine(target,JournalName)),"OMR_PRIOR_TRANSACTION");
  var rows=new List<Dictionary<string,object>>();
  foreach(string name in ReceiptNames){
   string incoming=Hash(Path.Combine(source,name)),to=Path.Combine(target,name);
   rows.Add(new Dictionary<string,object>{{"name",name},{"incoming",incoming},{"previous",IsRegular(to)?Hash(to):""}});
  }
  string id=Guid.NewGuid().ToString("N"),backup=BackupPath(target,id);Directory.CreateDirectory(backup);
  var journal=new Dictionary<string,object>{{"version",1},{"purpose","owner-msi-relocation"},{"id",id},{"entries",rows}};
  string journalPath=Path.Combine(target,JournalName);
  var bytes=new UTF8Encoding(false,true).GetBytes(new JavaScriptSerializer().Serialize(journal));
  using(var f=new FileStream(journalPath,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){f.Write(bytes,0,bytes.Length);f.Flush(true);}
  int completed=0;
  foreach(var row in rows){
   string name=(string)row["name"],from=Path.Combine(source,name),to=Path.Combine(target,name);
   string original=Path.Combine(backup,name),staged=Path.Combine(backup,name+".incoming");
   if((string)row["previous"]!=""){
    Need(Hash(to)==(string)row["previous"],"OMR_TARGET_CHANGED");File.Move(to,original);
   }else Need(!File.Exists(to)&&!Directory.Exists(to),"OMR_TARGET_CHANGED");
   using(var input=new FileStream(from,FileMode.Open,FileAccess.Read,FileShare.Read))
   using(var output=new FileStream(staged,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){input.CopyTo(output);output.Flush(true);}
   Need(Hash(staged)==(string)row["incoming"],"OMR_SOURCE_CHANGED");File.Move(staged,to);
   completed++;if(failAfter>0&&completed==failAfter)throw new InvalidOperationException("OMR_TEST_FAILURE");
  }
 }
 internal static void Rollback(string target){
  target=Path.GetFullPath(target).TrimEnd('\\');var journal=ReadJournal(target);
  string backup=BackupPath(target,Text(journal,"id"));
  var entries=(System.Collections.ArrayList)journal["entries"];
  // Check every file before changing anything. Unexpected data is quarantined,
  // never deleted or replaced merely because it has a familiar filename.
  foreach(Dictionary<string,object> row in entries){
   string name=Text(row,"name"),incoming=Text(row,"incoming"),previous=Text(row,"previous");
   string to=Path.Combine(target,name),old=Path.Combine(backup,name),staged=Path.Combine(backup,name+".incoming");
   bool hasTarget=IsRegular(to),hasOld=IsRegular(old);
   if(hasOld)Need(previous!=""&&Hash(old)==previous,"OMR_BACKUP_CHANGED");
   if(hasTarget){string hash=Hash(to);Need(hash==incoming||(!hasOld&&previous!=""&&hash==previous),"OMR_TARGET_CHANGED");}
   if(previous!=""&&!hasOld)Need(hasTarget&&Hash(to)==previous,"OMR_BACKUP_MISSING");
   // An interrupted write can leave a partial staged file. Preserve it in
   // the private backup rather than blocking restoration or deleting it.
   IsRegular(staged);
  }
  foreach(Dictionary<string,object> row in entries){
   string name=Text(row,"name"),incoming=Text(row,"incoming"),previous=Text(row,"previous");
   string to=Path.Combine(target,name),old=Path.Combine(backup,name),staged=Path.Combine(backup,name+".incoming");
   bool hasOld=IsRegular(old);
   if(IsRegular(to)&&(hasOld||previous=="")&&Hash(to)==incoming)File.Delete(to);
   if(hasOld){Need(!File.Exists(to),"OMR_TARGET_CHANGED");File.Move(old,to);}
   if(IsRegular(staged)&&Hash(staged)==incoming)File.Delete(staged);
  }
  File.Delete(Path.Combine(target,JournalName));
  if(!Directory.EnumerateFileSystemEntries(backup).Any())Directory.Delete(backup,false);
 }
}
