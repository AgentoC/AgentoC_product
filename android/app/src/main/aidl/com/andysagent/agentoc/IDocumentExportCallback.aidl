package com.andysagent.agentoc;
interface IDocumentExportCallback {
    boolean authorize(String attempt);
    oneway void completed(String attempt, String errorCode, long bytes);
}
