package com.agentoncloud.android.api;
import com.agentoncloud.android.api.IAppApiCallback;

/** Append-only public v1 transport. Trusted identity is captured for every method. */
interface IAppApiService {
    void getApiInfo(String requestId, IAppApiCallback callback);
    void listCapabilities(String requestId, String filterJson, IAppApiCallback callback);
    void prepare(String requestId, String taskJson, IAppApiCallback callback);
    void commit(String requestId, String preparationId, IAppApiCallback callback);
    void getOperation(String requestId, String operationId, IAppApiCallback callback);
    void cancelOperation(String requestId, String operationId, IAppApiCallback callback);
    void subscribe(String requestId, String filterJson, IAppApiCallback callback);
    void unsubscribe(String requestId, String subscriptionId, IAppApiCallback callback);
    void invoke(String requestId, String invocationJson, IAppApiCallback callback);
}
