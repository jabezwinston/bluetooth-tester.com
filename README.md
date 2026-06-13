# [bluetooth-tester.com](https://bluetooth-tester.com)

A website to explore the Bluetooth protocol from the **peripheral/slave** side. It implements a Bluetooth **Host** stack in plain JavaScript and drives a real Bluetooth **Controller** over its raw **HCI** interface (H4 over UART) using the browser's **Web Serial API**.

> This is **not** the Web Bluetooth API. That API only exposes a sandboxed GATT *client*. This tool talks raw HCI, so it can advertise, act as a GATT *server*, run SMP pairing, emulate HID, and more.
