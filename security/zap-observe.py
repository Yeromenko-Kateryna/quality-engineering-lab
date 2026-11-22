"""Record the packaged baseline's scope, examined URLs and remaining passive work."""
import json


def zap_pre_shutdown(zap):
    record = {
        "version": zap.core.version,
        "scope": zap.context.include_regexs("QEL4"),
        "urls": zap.core.urls(),
        "passiveRemaining": int(zap.pscan.records_to_scan),
    }
    print("QEL_ZAP_OBSERVATION " + json.dumps(record), flush=True)
