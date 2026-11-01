using System;
using System.Reflection;
using AgentoC.ServiceHost;

public static class AdministrativeInputStageTest {
    public static int Main() {
        var method=typeof(AgentoCService).GetMethod("AdministrativeInputStage",BindingFlags.NonPublic|BindingFlags.Static);
        if(method==null)throw new Exception("Missing diagnostic classifier");
        string input=@"C:\ProgramData\AgentoC\instances\owner\security\owner-bootstrap-install.json";
        Check(method,@"C:\",input,false,"SHT_INPUT_DRIVE_ROOT");
        Check(method,@"C:\ProgramData",input,false,"SHT_INPUT_PROGRAMDATA");
        Check(method,@"C:\Program Files",input,false,"SHT_INPUT_PROGRAM_FILES");
        Check(method,@"C:\ProgramData\AgentoC\instances\owner\security",input,false,"SHT_INPUT_PARENT");
        Check(method,@"C:\ProgramData\AgentoC",input,false,"SHT_INPUT_OTHER_ANCESTOR");
        Check(method,input,input,true,"SHT_INPUT_FILE");
        Console.WriteLine("Administrative input diagnostics passed.");
        return 0;
    }
    private static void Check(MethodInfo method,string path,string input,bool file,string expected) {
        var result=(string)method.Invoke(null,new object[]{path,input,file});
        if(result!=expected)throw new Exception("Unexpected diagnostic category: "+result);
    }
}
