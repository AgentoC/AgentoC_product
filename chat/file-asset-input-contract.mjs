// Pure contract shared by the control-plane staging gate and the detached
// runner verifier. Keep this module free of config, filesystem, and provider
// imports so the runner cannot gain a control-plane data path by importing it.

export const FILE_ASSET_INPUT_STAGING_SCHEMA_VERSION = 'file-asset-input-staging/v1';
export const FILE_ASSET_READ_OPERATION = 'file_asset.read';
export const FILE_ASSET_ID_PATTERN = /^fasset_[a-f0-9]{24}$/;
export const FILE_ASSET_READ_EFFECTS = Object.freeze([
  'control_plane.asset_descriptor.read',
  'control_plane.object_storage.read',
  'control_plane.run_input.write',
  'runner.current_run_input.read',
]);
