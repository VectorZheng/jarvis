const { withAndroidManifest } = require('expo/config-plugins');

/** 配置只经CNG生成；双服务/权限来自本地模块manifest，不维护生成工程。 */
module.exports = function withCompanion(config) {
  return withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    const application = manifest.application[0];
    application.$['android:allowBackup'] = 'false';
    application.$['android:fullBackupContent'] = '@xml/jarvis_backup_rules';
    application.$['android:dataExtractionRules'] = '@xml/jarvis_data_extraction_rules';
    const replacements = new Set((application.$['tools:replace'] || '').split(',').filter(Boolean));
    ['android:allowBackup', 'android:fullBackupContent', 'android:dataExtractionRules'].forEach((key) => replacements.add(key));
    application.$['tools:replace'] = [...replacements].join(',');
    for (const activity of application.activity || []) activity.$['android:resizeableActivity'] = 'true';
    return result;
  });
};
