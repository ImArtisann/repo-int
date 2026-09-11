// Vendored from https://github.com/typeonce-dev/ai-automation at 0bca096fe6fe9878cd15303a623dd2cd85915ddd (rules ported to defineRule)
import { definePlugin } from "@oxlint/plugins";

import noAmbientNondeterminism from "./no-ambient-nondeterminism.ts";
import noCascadingLayerProvide from "./no-cascading-layer-provide.ts";
import noDirectBrowserStorage from "./no-direct-browser-storage.ts";
import noDirectFetch from "./no-direct-fetch.ts";
import noDisableValidation from "./no-disable-validation.ts";
import noEffectAsVoid from "./no-effect-asvoid.ts";
import noGlobalJson from "./no-global-json.ts";
import noInOperator from "./no-in-operator.ts";
import noNestedEffectArrayMethods from "./no-nested-effect-array-methods.ts";
import noNestedLayerProvide from "./no-nested-layer-provide.ts";
import noServiceOption from "./no-service-option.ts";
import noShadowedStandardArrayStatic from "./no-shadowed-standard-array-static.ts";
import noSilentErrorSwallow from "./no-silent-error-swallow.ts";
import noStaticEffectServiceForwarders from "./no-static-effect-service-forwarders.ts";
import noSwitch from "./no-switch.ts";
import noTryCatch from "./no-try-catch.ts";
import noTypeofObject from "./no-typeof-object.ts";
import pipeMaxArguments from "./pipe-max-arguments.ts";
import preferEffectMatch from "./prefer-effect-match.ts";
import preferOptionFromNullable from "./prefer-option-from-nullable.ts";
import requireContextServiceInServices from "./require-context-service-in-services.ts";

/** Effect-focused Oxlint rules that enforce Effect usage conventions. */
const effectPlugin = definePlugin({
    meta: { name: "effect" },
    rules: {
        "no-ambient-nondeterminism": noAmbientNondeterminism,
        "no-cascading-layer-provide": noCascadingLayerProvide,
        "no-direct-browser-storage": noDirectBrowserStorage,
        "no-direct-fetch": noDirectFetch,
        "no-disable-validation": noDisableValidation,
        "no-effect-asvoid": noEffectAsVoid,
        "no-global-json": noGlobalJson,
        "no-in-operator": noInOperator,
        "no-nested-effect-array-methods": noNestedEffectArrayMethods,
        "no-nested-layer-provide": noNestedLayerProvide,
        "no-service-option": noServiceOption,
        "no-shadowed-standard-array-static": noShadowedStandardArrayStatic,
        "no-silent-error-swallow": noSilentErrorSwallow,
        "no-static-effect-service-forwarders": noStaticEffectServiceForwarders,
        "no-switch": noSwitch,
        "no-try-catch": noTryCatch,
        "no-typeof-object": noTypeofObject,
        "pipe-max-arguments": pipeMaxArguments,
        "prefer-effect-match": preferEffectMatch,
        "prefer-option-from-nullable": preferOptionFromNullable,
        "require-context-service-in-services": requireContextServiceInServices,
    },
});

export default effectPlugin;
