package com.agentoncloud.android.api;

oneway interface IAppApiCallback {
    void onResponse(String requestId, String responseJson);
}
