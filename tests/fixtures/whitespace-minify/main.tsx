// Regression fixture for the pass-2 whitespace-only guest minify
// (tools/build.ts Bun.build `minify` config; tested by
// tests/guest-minify.test.ts). The canary identifiers and constructs below
// are asserted on in the shipped bundle: Bun's whitespace mode removes
// comments/layout whitespace and can omit optional semicolons, while
// identifiers, parsed syntax structure, and string interiors survive.
import { mount } from "@pocketjs/framework";

function canaryComputeCanary598(flag: boolean): number {
  const canaryLocalValue598 = 7;
  if (flag) {
    return canaryLocalValue598;
  }
  return canaryLocalValue598 * 2;
}

function canaryFunctionSource630(): number {
  // Function source sentinel 630: removal is observable through
  // Function.prototype.toString(), even though calling the function is not.
  return 42;
}

function CanaryComponent598() {
  const value = canaryComputeCanary598(true);
  const sourceValue = canaryFunctionSource630();
  return (
    <div class="flex items-center" title={`v=${value}:${sourceValue}`}>
      canary {value ? true : false}
    </div>
  );
}

mount(() => <CanaryComponent598 />);
