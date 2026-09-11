// Vendored from https://github.com/typeonce-dev/ai-automation at 0bca096fe6fe9878cd15303a623dd2cd85915ddd (rules ported to defineRule)
import { definePlugin } from "@oxlint/plugins";

import noDirectXstateCreateMachine from "./no-direct-xstate-create-machine.ts";
import noDirectXstateUseSelector from "./no-direct-xstate-use-selector.ts";
import noMultipleXstateHooks from "./no-multiple-xstate-hooks.ts";
import noSingleUseXstateActions from "./no-single-use-xstate-actions.ts";
import noSingleUseXstateGuards from "./no-single-use-xstate-guards.ts";
import requireXstateEventSatisfies from "./require-xstate-event-satisfies.ts";

/** XState-focused Oxlint rules that enforce typed machine conventions. */
const xstatePlugin = definePlugin({
    meta: { name: "xstate" },
    rules: {
        "no-direct-xstate-create-machine": noDirectXstateCreateMachine,
        "no-direct-xstate-use-selector": noDirectXstateUseSelector,
        "no-multiple-xstate-hooks": noMultipleXstateHooks,
        "no-single-use-xstate-actions": noSingleUseXstateActions,
        "no-single-use-xstate-guards": noSingleUseXstateGuards,
        "require-xstate-event-satisfies": requireXstateEventSatisfies,
    },
});

export default xstatePlugin;
