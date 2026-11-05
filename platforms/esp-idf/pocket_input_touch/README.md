# Touch input source

`pocket_input_touch_create` borrows an initialized `esp_lcd_touch_handle_t`.
The product owns controller setup and destruction. The adapter reads one contact
and maps it into logical coordinates with `scale_x` and `scale_y`; the IDF
coordinate API has no persistent contact identifiers for multiple fingers.
Read failures cancel a prior contact. A failed input-builder append preserves
that cancellation until an append succeeds. Polling and destruction run on the
runtime's owning task.
