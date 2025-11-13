// Shopify API連携基盤
// Shopifyストアからの注文データ取得機能

export interface ShopifyConfig {
  shopDomain: string
  accessToken: string
  apiVersion?: string
}

export interface ShopifyOrder {
  id: string
  orderNumber: string
  email: string
  createdAt: string
  totalPrice: string
  currency: string
  lineItems: Array<{
    id: string
    title: string
    quantity: number
    price: string
  }>
  customer?: {
    id: string
    email: string
  }
  tags?: string[]
}

// Shopifyから注文データを取得
export async function fetchShopifyOrders(
  config: ShopifyConfig,
  startDate: string,
  endDate: string
): Promise<ShopifyOrder[]> {
  // TODO: Shopify Admin API実装
  // 現在はモック実装
  console.log('Shopify Orders fetch:', { config, startDate, endDate })
  
  return []
}

// 注文データをセッションIDと紐付け
export async function linkOrderToSession(
  order: ShopifyOrder,
  sessionId: string
): Promise<boolean> {
  // TODO: 注文データとセッションIDの紐付け実装
  console.log('Link order to session:', { order, sessionId })
  
  return true
}







