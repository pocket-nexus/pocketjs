# GPIO and ADC button source

`pocket_input_gpio_create` copies up to 32 GPIO mappings and 16 ADC windows.
The product configures GPIO pins and ADC one-shot handles. The adapter borrows
those resources and maps their levels or inclusive ADC ranges into button bits.
The debounce interval applies to the combined mask using `esp_timer` time.
ADC read failures release that channel's button bits and remain available through
`pocket_input_gpio_last_error`. Polling and destruction run on the runtime's task.
