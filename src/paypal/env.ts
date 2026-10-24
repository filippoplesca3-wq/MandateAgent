/**
 * Environment parsing shared by the HTTP server and the MCP entry point.
 */

/**
 * PAYPAL_MERCHANT_ALIASES maps PayPal identifiers to the names a mandate uses,
 * e.g. "HM98ZL79EKJ6Q=acme-supplies,sb-shop@business.example.com=acme-supplies".
 */
export function parseMerchantAliases(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined

  const aliases: Record<string, string> = {}
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=")
    if (at <= 0) continue
    const key = pair.slice(0, at).trim().toLowerCase()
    const value = pair.slice(at + 1).trim()
    if (!key || !value) continue
    aliases[key] = value
  }

  return Object.keys(aliases).length > 0 ? aliases : undefined
}
