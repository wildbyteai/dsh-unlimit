import { isIP } from "node:net";

/** Compose the verified provider's native URL, public-address and transport rules.
 * Each request owns its provider instance; concurrent calls never swap a shared resolver.
 */
export async function fetchScopedHttp(
  { HttpFetchProvider, native, scope, proxyRouteFor, guard, WebError },
  request,
  signal,
) {
  const deny = (code, message) => {
    throw new WebError(message, code);
  };
  const direct = (url) => {
    guard();
    if (proxyRouteFor(url).proxied)
      deny("WEB_SCOPE_PROXY_UNSUPPORTED", "当前代理未提供可核实的目标地址，范围控制拒绝本次请求");
  };
  const provider = new HttpFetchProvider({ ...native.limits }, async (hostname, hopSignal) => {
    guard();
    // Always preserve the host's complete answer-set public-only / NAT64 checks.
    const answers = await native.resolveAddresses(hostname, hopSignal);
    guard();
    let selected;
    let unverifiedIpv6 = false;
    for (const answer of answers) {
      const decision = scope.decide(hostname, answer.address);
      if (!decision.allowed) continue;
      // The native resolver does not expose discovered DNS64 prefixes. A country
      // for an IPv6 surface address cannot prove its translated IPv4 destination.
      const exception = ["exact-host", "resolved-exception"].includes(decision.reason);
      if (isIP(answer.address) === 6 && !exception) {
        unverifiedIpv6 = true;
        continue;
      }
      selected ??= { address: answer.address, family: answer.family };
    }
    guard();
    if (!selected)
      deny(
        unverifiedIpv6 ? "WEB_SCOPE_IPV6_UNVERIFIED" : "WEB_SCOPE_DENIED",
        unverifiedIpv6
          ? "当前宿主未提供 IPv6 翻译目标的地区信息，未找到可核实的允许地址"
          : "目标地址不在当前允许范围内",
      );
    return [selected];
  });
  const requestOnce = provider.requestOnce;
  provider.requestOnce = async function (url, hopSignal) {
    direct(url);
    if (scope.preview(url.hostname).state !== "ready")
      deny("WEB_SCOPE_DENIED", "目标不在当前允许范围内，未发起目标解析或连接");
    const resolve = provider.resolveAddresses;
    // A route change during DNS must not silently turn a newly proxied request
    // into a direct connection. This instance serves sequential native hops.
    provider.resolveAddresses = async (...args) => {
      const addresses = await resolve(...args);
      direct(url);
      return addresses;
    };
    try {
      return await requestOnce.call(this, url, hopSignal);
    } finally {
      provider.resolveAddresses = resolve;
    }
  };
  guard();
  const result = await provider.fetch(request, signal);
  guard();
  return result;
}
