/**
 * @file cmd_listener.c
 * @brief UDP command listener — receives server commands and acts on them.
 *
 * Protocol: [magic:4 LE][cmd_type:1][node_id:1][duration_ms:2 LE]
 * Total 8 bytes minimum. The node only acts if node_id matches its own
 * or is 0xFF (broadcast).
 *
 * CMD_IDENTIFY (0x01): blink the onboard LED for duration_ms milliseconds.
 *
 * Drives both LED types simultaneously so one firmware works on all boards:
 *   - WS2812 addressable RGB on GPIO 48 (ESP32-S3-DevKitC)
 *   - Plain GPIO LED on GPIO 8 (ESP32-S3 SuperMini / CH343 boards)
 */

#include "cmd_listener.h"

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "lwip/sockets.h"
#include "sdkconfig.h"
#include "nvs_config.h"
#include "led_strip.h"
#include "driver/gpio.h"

static const char *TAG = "cmd_listener";

extern nvs_config_t g_nvs_config;

#define LED_WS2812_GPIO  48
#define LED_PLAIN_GPIO   8

static volatile bool s_started = false;

/* ── Dual LED: WS2812 (DevKitC) + plain GPIO (SuperMini) ────────────────── */

static led_strip_handle_t s_led_strip = NULL;

static void led_init(void)
{
    /* WS2812 on GPIO 48 — harmless no-op if no WS2812 is connected */
    led_strip_config_t strip_config = {
        .strip_gpio_num = LED_WS2812_GPIO,
        .max_leds = 1,
    };
    led_strip_rmt_config_t rmt_config = {
        .resolution_hz = 10 * 1000 * 1000, /* 10 MHz */
    };
    esp_err_t err = led_strip_new_rmt_device(&strip_config, &rmt_config, &s_led_strip);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "WS2812 init failed (GPIO %d): %s", LED_WS2812_GPIO, esp_err_to_name(err));
        s_led_strip = NULL;
    } else {
        led_strip_clear(s_led_strip);
    }

    /* Plain GPIO on pin 8 — harmless no-op if nothing is on that pin */
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << LED_PLAIN_GPIO),
        .mode         = GPIO_MODE_OUTPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);
    gpio_set_level(LED_PLAIN_GPIO, 0);
}

static void led_on(void)
{
    if (s_led_strip) {
        led_strip_set_pixel(s_led_strip, 0, 0, 0, 255); /* blue */
        led_strip_refresh(s_led_strip);
    }
    gpio_set_level(LED_PLAIN_GPIO, 1);
}

static void led_off(void)
{
    if (s_led_strip) {
        led_strip_clear(s_led_strip);
    }
    gpio_set_level(LED_PLAIN_GPIO, 0);
}

/* ── LED blink ───────────────────────────────────────────────────────────── */

static void led_blink(uint16_t duration_ms)
{
    int cycles = duration_ms / 300;
    if (cycles < 3) cycles = 3;
    if (cycles > 20) cycles = 20;

    for (int i = 0; i < cycles; i++) {
        led_on();
        vTaskDelay(pdMS_TO_TICKS(150));
        led_off();
        vTaskDelay(pdMS_TO_TICKS(150));
    }
}

static void handle_identify(uint16_t duration_ms)
{
    ESP_LOGI(TAG, "IDENTIFY: blinking LEDs (WS2812@%d + GPIO@%d) for %u ms",
             LED_WS2812_GPIO, LED_PLAIN_GPIO, duration_ms);
    led_blink(duration_ms);
}

/* ── UDP command listener task ───────────────────────────────────────────── */

static void cmd_listener_task(void *arg)
{
    uint16_t port = (uint16_t)(uintptr_t)arg;
    if (port == 0) port = CMD_LISTENER_DEFAULT_PORT;

    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGE(TAG, "Failed to create socket: errno %d", errno);
        vTaskDelete(NULL);
        return;
    }

    struct sockaddr_in local_addr = {
        .sin_family = AF_INET,
        .sin_port   = htons(port),
        .sin_addr.s_addr = INADDR_ANY,
    };

    if (bind(sock, (struct sockaddr *)&local_addr, sizeof(local_addr)) < 0) {
        ESP_LOGE(TAG, "Bind failed on port %u: errno %d", port, errno);
        close(sock);
        vTaskDelete(NULL);
        return;
    }

    ESP_LOGI(TAG, "Listening on UDP port %u for server commands", port);
    led_init();

    uint8_t buf[64];
    while (1) {
        struct sockaddr_in src;
        socklen_t src_len = sizeof(src);
        int len = recvfrom(sock, buf, sizeof(buf), 0,
                           (struct sockaddr *)&src, &src_len);
        if (len < 8) continue;

        uint32_t magic = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
        if (magic != CMD_MAGIC) continue;

        uint8_t cmd_type = buf[4];
        uint8_t target_node = buf[5];
        uint16_t duration_ms = buf[6] | (buf[7] << 8);

        if (target_node != 0xFF && target_node != g_nvs_config.node_id) {
            continue;
        }

        switch (cmd_type) {
            case CMD_IDENTIFY:
                handle_identify(duration_ms);
                break;
            default:
                ESP_LOGW(TAG, "Unknown command type: 0x%02x", cmd_type);
                break;
        }
    }
}

esp_err_t cmd_listener_start(uint16_t port)
{
    if (s_started) return ESP_OK;
    s_started = true;

    BaseType_t ret = xTaskCreate(
        cmd_listener_task,
        "cmd_listen",
        3072,
        (void *)(uintptr_t)port,
        3,
        NULL
    );

    return (ret == pdPASS) ? ESP_OK : ESP_FAIL;
}
