package ai.agentwallet.hd;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Adapter for OpenClaw's demo {@code food_order} / restaurant fields.
 *
 * <p>These are a demo-only convenience and are NOT part of the core Payment Request
 * protocol, so they live here in their own metadata adapter instead of being parsed
 * inline in {@link PaymentIntent}. Keeping them out of the core model limits protocol
 * drift: if the demo payload shape changes, only this adapter moves. Mirrors the iOS
 * {@code DemoOrderMetadata}. The parsing logic is unchanged from what PaymentIntent
 * did inline (see AGENTS.md item 9: keep the wallet core generic — no app-specific
 * demo flows in wallet code).
 */
final class DemoOrderMetadata {
    final String orderId;
    final String orderType;
    final String orderUrl;
    final String shoppingSiteUrl;
    final String restaurantName;
    final String restaurantCuisine;
    final String restaurantImageUrl;
    final String restaurantUrl;
    final String itemSummary;
    final String orderSubtotalUsd;
    final String orderDeliveryFeeUsd;
    final String orderTotalUsd;
    final String orderEtaMinutes;
    final String agentPrompt;
    final String agentNote;
    final List<OrderItem> orderItems;

    private DemoOrderMetadata(
            String orderId,
            String orderType,
            String orderUrl,
            String shoppingSiteUrl,
            String restaurantName,
            String restaurantCuisine,
            String restaurantImageUrl,
            String restaurantUrl,
            String itemSummary,
            String orderSubtotalUsd,
            String orderDeliveryFeeUsd,
            String orderTotalUsd,
            String orderEtaMinutes,
            String agentPrompt,
            String agentNote,
            List<OrderItem> orderItems
    ) {
        this.orderId = orderId;
        this.orderType = orderType;
        this.orderUrl = orderUrl;
        this.shoppingSiteUrl = shoppingSiteUrl;
        this.restaurantName = restaurantName;
        this.restaurantCuisine = restaurantCuisine;
        this.restaurantImageUrl = restaurantImageUrl;
        this.restaurantUrl = restaurantUrl;
        this.itemSummary = itemSummary;
        this.orderSubtotalUsd = orderSubtotalUsd;
        this.orderDeliveryFeeUsd = orderDeliveryFeeUsd;
        this.orderTotalUsd = orderTotalUsd;
        this.orderEtaMinutes = orderEtaMinutes;
        this.agentPrompt = agentPrompt;
        this.agentNote = agentNote;
        this.orderItems = orderItems;
    }

    static DemoOrderMetadata parse(JSONObject raw) {
        if (raw == null) raw = new JSONObject();
        JSONObject Paytobe = raw.optJSONObject("Paytobe");
        if (Paytobe == null) Paytobe = new JSONObject();
        JSONObject payload = Paytobe.optJSONObject("payload");
        JSONObject metadata = raw.optJSONObject("metadata");
        if (metadata == null) metadata = new JSONObject();
        JSONObject order = firstObject(
                raw.optJSONObject("order"),
                payload == null ? null : payload.optJSONObject("order"),
                metadata.optJSONObject("food_order")
        );
        if (order == null) order = new JSONObject();
        JSONObject restaurant = order.optJSONObject("restaurant");
        if (restaurant == null) restaurant = new JSONObject();
        JSONObject pricing = order.optJSONObject("pricing");
        if (pricing == null) pricing = new JSONObject();
        JSONObject merchant = firstObject(
                raw.optJSONObject("merchant"),
                payload == null ? null : payload.optJSONObject("merchant")
        );
        if (merchant == null) merchant = new JSONObject();
        JSONObject agentContext = order.optJSONObject("agent_context");
        if (agentContext == null) agentContext = new JSONObject();

        String orderUrl = normalizePublicUrl(order.optString("url", ""));
        String merchantWebsite = normalizePublicUrl(merchant.optString("website", ""));
        return new DemoOrderMetadata(
                order.optString("id", order.optString("order_id", "")),
                order.optString("type", ""),
                orderUrl,
                normalizePublicUrl(firstNonEmpty(order.optString("shopping_site_url", ""), order.optString("website_url", ""), orderUrl, merchantWebsite)),
                restaurant.optString("name", ""),
                restaurant.optString("cuisine", ""),
                firstNonEmpty(restaurant.optString("image_url", ""), restaurant.optString("hero_image_url", "")),
                normalizePublicUrl(restaurant.optString("url", "")),
                order.optString("item_summary", ""),
                pricing.optString("subtotal_usd", ""),
                pricing.optString("delivery_fee_usd", ""),
                pricing.optString("total_usd", ""),
                String.valueOf(restaurant.opt("eta_minutes") == null ? "" : restaurant.opt("eta_minutes")),
                agentContext.optString("user_prompt", ""),
                agentContext.optString("note", ""),
                readOrderItems(order.optJSONArray("items"))
        );
    }

    boolean hasOrderDetails() {
        return orderId.length() > 0 || restaurantName.length() > 0 || itemSummary.length() > 0 || !orderItems.isEmpty();
    }

    String primaryImageUrl() {
        for (OrderItem item : orderItems) {
            if (item.imageUrl.length() > 0) return item.imageUrl;
        }
        return restaurantImageUrl;
    }

    private static JSONObject firstObject(JSONObject... values) {
        if (values == null) return null;
        for (JSONObject value : values) {
            if (value != null) return value;
        }
        return null;
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return "";
        for (String value : values) {
            if (value != null && value.trim().length() > 0 && !"null".equalsIgnoreCase(value.trim())) {
                return value.trim();
            }
        }
        return "";
    }

    private static String normalizePublicUrl(String value) {
        if (value == null) return "";
        return value.trim();
    }

    private static List<OrderItem> readOrderItems(JSONArray array) {
        List<OrderItem> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            out.add(new OrderItem(
                    item.optString("name", item.optString("item_id", "Item")),
                    item.optInt("quantity", 1),
                    item.optString("line_total_usd", ""),
                    item.optString("description", ""),
                    item.optString("image_url", ""),
                    normalizePublicUrl(item.optString("url", "")),
                    item.optString("note", "")
            ));
        }
        return out;
    }

    static final class OrderItem {
        final String name;
        final int quantity;
        final String lineTotalUsd;
        final String description;
        final String imageUrl;
        final String url;
        final String note;

        OrderItem(String name, int quantity, String lineTotalUsd, String description, String imageUrl, String url, String note) {
            this.name = name;
            this.quantity = quantity;
            this.lineTotalUsd = lineTotalUsd;
            this.description = description;
            this.imageUrl = imageUrl;
            this.url = url;
            this.note = note;
        }
    }
}
