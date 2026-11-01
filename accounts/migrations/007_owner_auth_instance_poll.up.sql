-- instance_poll 交付模式：无公网实例主动轮询领取完成断言。
-- delivery_mode 区分 browser_callback（默认，旧数据兼容）与 instance_poll；
-- poll_request_id 绑定首次领取的幂等请求 ID；poll_assertion 只在 60 秒
-- 窗口内用于响应丢失后的同 requestId 重放。
alter table owner_auth_transactions
  add column if not exists delivery_mode text not null default 'browser_callback',
  add column if not exists poll_request_id text not null default '',
  add column if not exists poll_redeemed_at timestamptz,
  add column if not exists poll_assertion text,
  add column if not exists poll_expires_at timestamptz;

-- instance_poll deliberately has no callback URL. Existing callback rows keep
-- their value; new poll rows use NULL rather than an empty placeholder.
alter table owner_auth_transactions
  alter column return_url drop not null;
