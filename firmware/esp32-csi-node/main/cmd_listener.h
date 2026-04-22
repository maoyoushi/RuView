/**
 * @file cmd_listener.h
 * @brief UDP command listener for server-to-device commands.
 *
 * Listens on a configurable UDP port for commands from the sensing server.
 * Currently supports: IDENTIFY (blink onboard LED to help locate a device).
 */

#ifndef CMD_LISTENER_H
#define CMD_LISTENER_H

#include <stdint.h>
#include "esp_err.h"

#define CMD_LISTENER_DEFAULT_PORT  5006
#define CMD_MAGIC                  0xC511FF01u

typedef enum {
    CMD_IDENTIFY = 0x01,
} cmd_type_t;

/**
 * Start the command listener task.
 *
 * Binds a UDP socket on the given port and spawns a FreeRTOS task that
 * dispatches incoming commands. Safe to call once; subsequent calls are no-ops.
 *
 * @param port  UDP port to listen on (0 = CMD_LISTENER_DEFAULT_PORT).
 * @return ESP_OK on success.
 */
esp_err_t cmd_listener_start(uint16_t port);

#endif /* CMD_LISTENER_H */
