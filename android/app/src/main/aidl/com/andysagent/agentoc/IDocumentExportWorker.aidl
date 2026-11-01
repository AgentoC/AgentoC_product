package com.andysagent.agentoc;
import android.os.ParcelFileDescriptor;
import com.andysagent.agentoc.IDocumentExportCallback;
interface IDocumentExportWorker {
    int start(String attempt, String ticket, in ParcelFileDescriptor source, String destination,
        long bytes, String sha256, long deadlineElapsed, IDocumentExportCallback callback);
    oneway void abort(String attempt);
}
