using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

internal static class AgentoCSetup {
    private const string PayloadResource = "AgentoC.Payload.msi";
    private const string HashResource = "AgentoC.Payload.sha256";

    [STAThread]
    private static int Main(string[] args) {
        string directory = null;
        string payloadPath = null;
        try {
            directory = Path.Combine(Path.GetTempPath(), "AgentoC-setup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            payloadPath = Path.Combine(directory, "AgentoC.msi");
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream input = assembly.GetManifestResourceStream(PayloadResource)) {
                if (input == null) throw new InvalidOperationException("Installer payload is missing.");
                using (FileStream output = new FileStream(payloadPath, FileMode.CreateNew, FileAccess.Write, FileShare.None)) input.CopyTo(output);
            }
            string expected;
            using (Stream input = assembly.GetManifestResourceStream(HashResource)) {
                if (input == null) throw new InvalidOperationException("Installer checksum is missing.");
                using (StreamReader reader = new StreamReader(input, Encoding.ASCII)) expected = reader.ReadToEnd().Trim();
            }
            string actual;
            using (SHA256 hash = SHA256.Create())
            using (FileStream input = File.OpenRead(payloadPath)) actual = BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "");
            if (!String.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Installer payload verification failed.");

            StringBuilder command = new StringBuilder("/i ").Append(Quote(payloadPath));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            ProcessStartInfo start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "msiexec.exe"), command.ToString());
            start.UseShellExecute = false;
            using (Process process = Process.Start(start)) {
                if (process == null) throw new InvalidOperationException("Windows Installer could not be started.");
                process.WaitForExit();
                return process.ExitCode;
            }
        } catch (Exception error) {
            MessageBox.Show("AgentoC setup could not start.\n\n" + error.Message, "AgentoC Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        } finally {
            try { if (payloadPath != null && File.Exists(payloadPath)) File.Delete(payloadPath); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            try { if (directory != null && Directory.Exists(directory)) Directory.Delete(directory, false); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    // Windows command line escaping for CommandLineToArgvW / MSI arguments.
    private static string Quote(string value) {
        StringBuilder text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { text.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
            text.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        text.Append('\\', slashes * 2).Append('"');
        return text.ToString();
    }
}
