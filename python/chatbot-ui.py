from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageEnhance
import os
import time
import socket
import json
import sys
import threading
import signal
import math

# from whisplay import WhisplayBoard
from whisplay import WhisplayBoard
from camera import CameraThread
from utils import ColorUtils, ImageUtils, TextUtils

STATUS_ICON_DIR = os.path.join(os.path.dirname(__file__), "status-bar-icon")
if STATUS_ICON_DIR not in sys.path:
    sys.path.append(STATUS_ICON_DIR)

from battery_icon import BatteryStatusIcon
from network_icon import NetworkStatusIcon
from rag_icon import RagStatusIcon
from image_icon import ImageStatusIcon

scroll_thread = None
scroll_stop_event = threading.Event()

status_font_size=10
emoji_font_size=0
battery_font_size=9

# Global variables
current_status = "Hello"
current_emoji = "😄"
current_text = "Waiting for message..."
current_battery_level = 100
current_battery_color = ColorUtils.get_rgb255_from_any("#55FF00")
current_scroll_top = 0
DEFAULT_SCROLL_SPEED = 0.25
MAX_SCROLL_SPEED = 0.5
current_scroll_speed = DEFAULT_SCROLL_SPEED
current_scroll_sync_char_end = None
current_scroll_sync_duration_ms = None
current_scroll_sync_target_top = None
current_scroll_sync_speed = None
current_scroll_sync_hold_until = 0.0
current_transaction_id = None
current_image_path = ""
current_image = None
current_network_connected = None
current_rag_icon_visible = False
current_image_icon_visible = False
camera_mode = False
camera_capture_image_path = ""
camera_thread = None
clients = {}
status_icon_factories = []


def register_status_icon_factory(factory, priority=100):
    status_icon_factories.append({"priority": priority, "factory": factory})

class RenderThread(threading.Thread):
    def __init__(self, whisplay, font_path, fps=30):
        super().__init__()
        self.whisplay = whisplay
        self.font_path = font_path
        self.fps = fps
        self.assets_root = os.path.dirname(__file__)
        self.animation_start_ts = time.time()
        self.last_text_update_at = 0.0
        self.last_rendered_text = ""
        self.portrait_variant_cache = {}
        self.render_init_screen()
        # Clear logo after 1 second and start running loop
        time.sleep(1)
        self.running = True
        self.status_font = ImageFont.truetype(self.font_path, 10)
        self.subline_font = ImageFont.truetype(self.font_path, 8)
        self.panel_font = ImageFont.truetype(self.font_path, 9)
        self.freq_font = ImageFont.truetype(self.font_path, 20)
        self.voice_font = ImageFont.truetype(self.font_path, 9)
        self.main_text_font = ImageFont.truetype(self.font_path, 16)
        self.main_text_line_height = self.main_text_font.getmetrics()[0] + self.main_text_font.getmetrics()[1]
        self.caller_portrait = self.load_codec_portrait([
            os.path.join("img", "MGS_PS1-Topless-snake.png"),
            os.path.join("..", "web", "whisplay-display", "img", "MGS_PS1-Topless-snake.png"),
            os.path.join("img", "logo.png"),
            os.path.join("..", "web", "whisplay-display", "img", "logo.png"),
        ])
        self.callee_portrait = self.load_codec_portrait([
            os.path.join("img", "MGS_PS1-Ocaton-final.png"),
            os.path.join("..", "web", "whisplay-display", "img", "MGS_PS1-Ocaton-final.png"),
            os.path.join("img", "logo.png"),
            os.path.join("..", "web", "whisplay-display", "img", "logo.png"),
        ])

    def resolve_asset_path(self, candidates):
        for relative_path in candidates:
            candidate = os.path.abspath(os.path.join(self.assets_root, relative_path))
            if os.path.exists(candidate):
                return candidate
        return None

    def load_codec_portrait(self, candidates):
        path = self.resolve_asset_path(candidates)
        if not path:
            return None
        try:
            image = Image.open(path).convert("RGBA")
            gray = ImageOps.grayscale(image)
            tinted = ImageOps.colorize(gray, black="#08120d", white="#88e0a8").convert("RGBA")
            tinted = ImageEnhance.Contrast(tinted).enhance(1.25)
            tinted = ImageEnhance.Brightness(tinted).enhance(0.92)
            return tinted
        except Exception as error:
            print(f"[Render] Failed to load portrait {path}: {error}")
            return None

    def get_codec_mode(self, status_text):
        normalized = (status_text or "").lower()
        if ("error" in normalized) or ("offline" in normalized) or ("fail" in normalized):
            return "alert"
        if ("listen" in normalized) or ("wake" in normalized) or ("record" in normalized):
            return "listening"
        if ("answer" in normalized) or ("speak" in normalized) or ("reply" in normalized):
            return "talking"
        if time.time() - self.last_text_update_at < 0.9:
            return "talking"
        return "idle"

    def render_init_screen(self):
        # Display logo on startup
        logo_path = os.path.join("img", "logo.png")
        if os.path.exists(logo_path):
            logo_image = Image.open(logo_path).convert("RGBA")
            logo_image = logo_image.resize((self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT), Image.LANCZOS)
            rgb565_data = ImageUtils.image_to_rgb565(logo_image, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT)
            self.whisplay.set_backlight(100)
            self.whisplay.draw_image(0, 0, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT, rgb565_data)

    def render_frame(self, status, emoji, text, scroll_top, battery_level, battery_color):
        global current_scroll_speed, current_image_path, current_image, camera_mode
        if camera_mode:
            return  # Skip rendering if in camera mode
        if current_image_path not in [None, ""]:
            # Try to load image from path
            if current_image is not None:
                rgb565_data = ImageUtils.image_to_rgb565(current_image, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT)
                self.whisplay.draw_image(0, 0, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT, rgb565_data)
            elif os.path.exists(current_image_path):
                try:
                    image = Image.open(current_image_path).convert("RGBA") # 1024x1024
                    # crop center and resize to fit screen ratio
                    img_w, img_h = image.size
                    screen_ratio = self.whisplay.LCD_WIDTH / self.whisplay.LCD_HEIGHT
                    img_ratio = img_w / img_h
                    if img_ratio > screen_ratio:
                        # crop width
                        new_w = int(img_h * screen_ratio)
                        left = (img_w - new_w) // 2
                        image = image.crop((left, 0, left + new_w, img_h))
                    else:
                        # crop height
                        new_h = int(img_w / screen_ratio)
                        top = (img_h - new_h) // 2
                        image = image.crop((0, top, img_w, top + new_h))
                    image = image.resize((self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT), Image.LANCZOS)
                    current_image = image
                    rgb565_data = ImageUtils.image_to_rgb565(image, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT)
                    self.whisplay.draw_image(0, 0, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT, rgb565_data)
                except Exception as e:
                    print(f"[Render] Failed to load image {current_image_path}: {e}")
        else:
            current_image = None
            width = self.whisplay.LCD_WIDTH
            height = self.whisplay.LCD_HEIGHT
            mode = self.get_codec_mode(status)
            now = time.time()
            if text != self.last_rendered_text:
                self.last_rendered_text = text
                self.last_text_update_at = now

            frame_image = Image.new("RGBA", (width, height), (3, 8, 6, 255))
            draw = ImageDraw.Draw(frame_image)

            self.render_header(frame_image, draw, status, emoji, battery_level, battery_color)

            top_panel = (6, 34, width - 7, 140)
            dialog_panel = (6, 148, width - 7, height - 8)
            panel_green = (92, 174, 127, 130)
            panel_fill = (7, 18, 13, 238)

            draw.rectangle(top_panel, fill=panel_fill, outline=panel_green, width=1)
            draw.rectangle(dialog_panel, fill=(3, 8, 6, 244), outline=(126, 210, 157, 170), width=1)

            left_x0 = top_panel[0] + 4
            left_x1 = left_x0 + 56
            right_x1 = top_panel[2] - 4
            right_x0 = right_x1 - 56
            center_x0 = left_x1 + 4
            center_x1 = right_x0 - 4
            portrait_y0 = top_panel[1] + 4
            portrait_y1 = top_panel[3] - 4

            self.draw_codec_portrait(
                frame_image,
                (left_x0, portrait_y0, left_x1, portrait_y1),
                self.caller_portrait,
                mode == "listening",
                mode == "alert",
            )
            self.draw_codec_portrait(
                frame_image,
                (right_x0, portrait_y0, right_x1, portrait_y1),
                self.callee_portrait,
                mode == "talking",
                mode == "alert",
            )

            center_rect = (center_x0, portrait_y0, center_x1, portrait_y1)
            draw.rectangle(center_rect, fill=(10, 24, 18, 220), outline=(113, 200, 146, 200), width=1)
            draw.text((center_rect[0] + (center_rect[2] - center_rect[0]) // 2 - 10, center_rect[1] + 2), "PTT", font=self.panel_font, fill=(103, 168, 126, 255))

            meter_x0 = center_rect[0] + 8
            meter_y0 = center_rect[1] + 18
            meter_y1 = center_rect[1] + 74
            segment_h = 4
            segment_gap = 2
            segment_count = 10
            t = now - self.animation_start_ts
            base_meter = 2
            if mode == "talking":
                base_meter = 6 + int((math.sin(t * 8.0) + 1.0) * 1.8)
            elif mode == "listening":
                base_meter = 4 + int((math.sin(t * 5.0) + 1.0) * 0.8)
            elif mode == "alert":
                base_meter = 1
            for index in range(segment_count):
                seg_y1 = meter_y1 - index * (segment_h + segment_gap)
                seg_y0 = seg_y1 - segment_h
                is_active = index < base_meter
                color = (145, 250, 180, 255) if is_active else (57, 102, 74, 180)
                draw.rectangle((meter_x0, seg_y0, meter_x0 + 14, seg_y1), fill=color)

            drift = 0.0
            if mode == "talking":
                drift = math.sin(t * 2.5) * 0.04
            elif mode == "listening":
                drift = math.sin(t * 1.4) * 0.02
            freq_text = f"{140.85 + drift:0.2f}"
            freq_bbox = self.freq_font.getbbox(freq_text)
            freq_w = freq_bbox[2] - freq_bbox[0]
            freq_x = center_rect[0] + (center_rect[2] - center_rect[0] - freq_w) // 2 + 10
            draw.text((freq_x, center_rect[1] + 32), freq_text, font=self.freq_font, fill=(142, 242, 176, 255))

            voice_label = "STBY"
            voice_color = (105, 168, 126, 255)
            if mode == "talking":
                voice_label = "RX"
                voice_color = (182, 255, 205, 255)
            elif mode == "listening":
                voice_label = "LISTEN"
            elif mode == "alert":
                voice_label = "ALERT"
                voice_color = (255, 126, 113, 255)
            draw.text((center_rect[0] + 35, center_rect[1] + 58), voice_label, font=self.voice_font, fill=voice_color)
            draw.text((center_rect[0] + 7, center_rect[3] - 10), "mem.", font=self.panel_font, fill=(102, 156, 120, 255))
            draw.text((center_rect[2] - 31, center_rect[3] - 10), "tune", font=self.panel_font, fill=(102, 156, 120, 255))

            self.render_main_text(frame_image, draw, text, dialog_panel, current_scroll_speed)

            scanline = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            scan_draw = ImageDraw.Draw(scanline)
            for y in range(0, height, 3):
                scan_draw.line([(0, y), (width, y)], fill=(132, 214, 163, 16), width=1)
            frame_image = Image.alpha_composite(frame_image, scanline)

            rgb565_data = ImageUtils.image_to_rgb565(frame_image, width, height)
            self.whisplay.draw_image(0, 0, width, height, rgb565_data)

    def draw_codec_portrait(self, canvas, rect, portrait_image, active=False, alert=False):
        x0, y0, x1, y1 = rect
        width = max(1, x1 - x0 + 1)
        height = max(1, y1 - y0 + 1)
        panel = Image.new("RGBA", (width, height), (16, 34, 25, 235))
        panel_draw = ImageDraw.Draw(panel)

        if portrait_image is not None:
            cache_key = (id(portrait_image), width, height, alert)
            resized = self.portrait_variant_cache.get(cache_key)
            if resized is None:
                src_w, src_h = portrait_image.size
                scale = max(width / src_w, height / src_h)
                resized = portrait_image.resize((int(src_w * scale), int(src_h * scale)), Image.LANCZOS)
                crop_x = max(0, (resized.width - width) // 2)
                crop_y = max(0, (resized.height - height) // 2)
                resized = resized.crop((crop_x, crop_y, crop_x + width, crop_y + height))
                if alert:
                    resized = ImageOps.colorize(ImageOps.grayscale(resized), black="#1a0908", white="#ff8f80").convert("RGBA")
                self.portrait_variant_cache[cache_key] = resized
            panel.paste(resized, (0, 0), resized)
        else:
            panel_draw.ellipse((18, 8, width - 18, height - 30), fill=(100, 180, 130, 70))
            panel_draw.rectangle((18, height - 36, width - 18, height - 8), fill=(92, 170, 124, 80))

        scan_offset = int(((time.time() - self.animation_start_ts) * 42) % (height + 22)) - 22
        panel_draw.rectangle((0, scan_offset, width, scan_offset + 18), fill=(186, 255, 207, 38))
        panel_draw.rectangle((0, 0, width - 1, height - 1), outline=(102, 190, 138, 190), width=1)
        if active:
            panel_draw.rectangle((1, 1, width - 2, height - 2), outline=(166, 255, 196, 190), width=1)
        if alert:
            panel_draw.rectangle((0, 0, width - 1, height - 1), outline=(255, 142, 126, 210), width=1)
        canvas.paste(panel, (x0, y0), panel)

    def compute_scroll_target_from_char_end(self, lines, line_height, area_height, char_end):
        if char_end is None or char_end <= 0:
            return 0
        total_chars = 0
        target_line = 0
        for i, line in enumerate(lines):
            total_chars += len(line)
            if total_chars >= char_end:
                target_line = i
                break
            if i < len(lines) - 1:
                total_chars += 1
        target_top = target_line * line_height - (area_height // 2)
        return max(0, target_top)

    def render_main_text(self, canvas, draw, text, panel_rect, scroll_speed=2):
        global current_scroll_top, current_scroll_sync_char_end
        global current_scroll_sync_duration_ms, current_scroll_sync_target_top
        global current_scroll_sync_speed, current_scroll_sync_hold_until

        if not text:
            return

        x0, y0, x1, y1 = panel_rect
        text_x = x0 + 10
        text_y = y0 + 8
        text_width = max(20, (x1 - x0) - 20)
        area_height = max(20, (y1 - y0) - 16)

        lines = TextUtils.wrap_text(draw, text, self.main_text_font, text_width)
        line_height = self.main_text_line_height
        max_scroll_top = max(0, (len(lines) + 1) * line_height - area_height)

        if current_scroll_sync_char_end is not None and current_scroll_sync_duration_ms is not None:
            target_top = self.compute_scroll_target_from_char_end(
                lines, line_height, area_height, current_scroll_sync_char_end
            )
            target_top = min(max_scroll_top, target_top)
            target_top = max(current_scroll_top, target_top)
            duration_ms = max(1, current_scroll_sync_duration_ms)
            frames = max(1, int(duration_ms * self.fps / 1000))
            current_scroll_sync_target_top = target_top
            current_scroll_sync_speed = (target_top - current_scroll_top) / frames
            current_scroll_sync_char_end = None
            current_scroll_sync_duration_ms = None

        for index, line in enumerate(lines):
            line_top = index * line_height
            screen_y = text_y + line_top - int(current_scroll_top)
            if screen_y + line_height < text_y or screen_y > text_y + area_height:
                continue
            TextUtils.draw_mixed_text(draw, canvas, line, self.main_text_font, (text_x, screen_y))

        if current_scroll_sync_speed is not None and current_scroll_sync_target_top is not None:
            remaining = current_scroll_sync_target_top - current_scroll_top
            if abs(remaining) <= abs(current_scroll_sync_speed):
                current_scroll_top = current_scroll_sync_target_top
                current_scroll_sync_speed = None
                current_scroll_sync_target_top = None
            else:
                current_scroll_top += current_scroll_sync_speed
        elif (
            scroll_speed > 0
            and current_scroll_top < max_scroll_top
            and time.time() >= current_scroll_sync_hold_until
        ):
            current_scroll_top += scroll_speed
        if current_scroll_top > max_scroll_top:
            current_scroll_top = max_scroll_top
                

    def render_header(self, image, draw, status, emoji, battery_level, battery_color):
        global current_status, current_emoji, current_battery_level, current_battery_color
        global status_font_size, emoji_font_size, battery_font_size

        image_width = self.whisplay.LCD_WIDTH
        bar_bottom = 29
        draw.rectangle((0, 0, image_width - 1, bar_bottom), fill=(8, 18, 14, 250), outline=(94, 172, 128, 165), width=1)
        draw.line((0, bar_bottom, image_width - 1, bar_bottom), fill=(116, 198, 150, 185), width=1)

        status_text = (current_status or "standby").upper()
        draw.text((8, 3), status_text, font=self.status_font, fill=(134, 234, 171, 255))
        draw.text((8, 15), "secure tactical comms channel", font=self.subline_font, fill=(94, 158, 121, 255))

        # Draw battery icon
        status_icon_context = {
            "battery_level": battery_level,
            "battery_color": battery_color,
            "battery_font": self.subline_font,
            "status_font_size": status_font_size,
            "network_connected": current_network_connected,
            "rag_icon_visible": current_rag_icon_visible,
            "image_icon_visible": current_image_icon_visible,
        }
        status_icons = self.build_status_icons(status_icon_context)
        self.render_status_icons(draw, status_icons, image_width)

    def build_status_icons(self, context):
        icons = []
        battery_level = context.get("battery_level")
        battery_color = context.get("battery_color")
        battery_font = context.get("battery_font")
        status_font_size = context.get("status_font_size")

        if battery_level is not None:
            icons.append(BatteryStatusIcon(battery_level, battery_color, battery_font, status_font_size))
        if context.get("network_connected"):
            icons.append(NetworkStatusIcon(status_font_size))
        if context.get("image_icon_visible"):
            icons.append(ImageStatusIcon(status_font_size))
        if context.get("rag_icon_visible"):
            icons.append(RagStatusIcon(status_font_size))

        for item in sorted(status_icon_factories, key=lambda entry: entry["priority"]):
            icon_list = item["factory"](context)
            if icon_list:
                icons.extend(icon_list)
        return icons

    def render_status_icons(self, draw, icons, image_width):
        if not icons:
            return
        right_margin = 10
        icon_gap = 8
        cursor_x = image_width - right_margin
        for icon in icons:
            icon_width, _ = icon.measure()
            icon_x = cursor_x - icon_width
            icon_y = icon.get_top_y()
            icon.render(draw, icon_x, icon_y)
            cursor_x = icon_x - icon_gap

    def run(self):
        frame_interval = 1 / self.fps
        while self.running:
            self.render_frame(current_status, current_emoji, current_text, current_scroll_top, current_battery_level, current_battery_color)
            time.sleep(frame_interval)
            
    def stop(self):
        self.running = False

def update_display_data(status=None, emoji=None, text=None,
                  scroll_speed=None, scroll_sync=None, battery_level=None, battery_color=None, image_path=None,
                  network_connected=None, rag_icon_visible=None, image_icon_visible=None, transaction_id=None):
    global current_status, current_emoji, current_text, current_battery_level
    global current_battery_color, current_scroll_top, current_scroll_speed, current_image_path
    global current_scroll_sync_char_end, current_scroll_sync_duration_ms
    global current_scroll_sync_target_top, current_scroll_sync_speed
    global current_scroll_sync_hold_until
    global current_network_connected, current_rag_icon_visible, current_image_icon_visible, current_transaction_id

    next_text = text
    if text is not None:
        previous_text = current_text or ""
        incoming_text = text or ""
        same_transaction = (
            transaction_id is not None
            and current_transaction_id is not None
            and transaction_id == current_transaction_id
        )
        regressive_update = (
            len(incoming_text) > 0
            and len(incoming_text) < len(previous_text)
            and previous_text.startswith(incoming_text)
        )
        if same_transaction and regressive_update:
            next_text = previous_text
        elif (
            transaction_id is not None
            and current_transaction_id is not None
            and transaction_id != current_transaction_id
        ):
            current_scroll_top = 0
            current_scroll_sync_char_end = None
            current_scroll_sync_duration_ms = None
            current_scroll_sync_target_top = None
            current_scroll_sync_speed = None
            TextUtils.clean_line_image_cache()
        elif not incoming_text.startswith(previous_text):
            if not previous_text.startswith(incoming_text):
                current_scroll_top = 0
                current_scroll_sync_char_end = None
                current_scroll_sync_duration_ms = None
                current_scroll_sync_target_top = None
                current_scroll_sync_speed = None
                TextUtils.clean_line_image_cache()
    if scroll_sync is not None:
        try:
            char_end = scroll_sync.get("char_end", None)
            duration_ms = scroll_sync.get("duration_ms", None)
            if char_end is not None and duration_ms is not None:
                current_scroll_sync_char_end = int(char_end)
                current_scroll_sync_duration_ms = int(duration_ms)
                hold_seconds = max(0.3, (current_scroll_sync_duration_ms / 1000.0) + 0.2)
                current_scroll_sync_hold_until = max(
                    current_scroll_sync_hold_until,
                    time.time() + hold_seconds,
                )
        except Exception as e:
            print(f"[Display] Invalid scroll_sync payload: {e}")
    if scroll_speed is not None:
        try:
            requested_speed = float(scroll_speed)
            current_scroll_speed = min(MAX_SCROLL_SPEED, max(0.0, requested_speed))
        except (TypeError, ValueError):
            print(f"[Display] Invalid scroll_speed payload: {scroll_speed}")
    if network_connected is not None:
        current_network_connected = network_connected
    if rag_icon_visible is not None:
        current_rag_icon_visible = rag_icon_visible
    if image_icon_visible is not None:
        current_image_icon_visible = image_icon_visible
    if transaction_id is not None:
        current_transaction_id = transaction_id
    current_status = status if status is not None else current_status
    current_emoji = emoji if emoji is not None else current_emoji
    current_text = next_text if text is not None else current_text
    current_battery_level = battery_level if battery_level is not None else current_battery_level
    current_battery_color = battery_color if battery_color is not None else current_battery_color
    current_image_path = image_path if image_path is not None else current_image_path


def send_to_all_clients(message):
    """Send message to all connected clients"""
    message_json = json.dumps(message).encode("utf-8") + b"\n"
    for addr, client_socket in clients.items():
        try:
            client_socket.sendall(message_json)
            # Use ellipsis for long messages
            if len(message_json) > 100:
                display_message = message_json[:50] + b"..." + message_json[-50:]
            else:
                display_message = message_json
            print(f"[Server] Sent notification to client {addr}: {display_message}")
        except Exception as e:
            print(f"[Server] Failed to send notification to client {addr}: {e}")

def exit_camera_mode():
    global camera_mode, camera_thread
    print("[Camera] Exiting camera mode...")
    if camera_thread is not None:
        camera_thread.stop()
        camera_thread = None
    notification = {"event": "exit_camera_mode"}
    send_to_all_clients(notification)
    camera_mode = False

def on_button_pressed():
    """Function executed when button is pressed"""
    print("[Server] Button pressed")
    notification = {"event": "button_pressed"}
    send_to_all_clients(notification)

def on_button_release():
    """Function executed when button is released"""
    print("[Server] Button released")
    notification = {"event": "button_released"}
    send_to_all_clients(notification)

def handle_client(client_socket, addr, whisplay):
    global camera_capture_image_path, camera_mode, camera_thread
    print(f"[Socket] Client {addr} connected")
    clients[addr] = client_socket
    try:
        buffer = ""
        while True:
            data = client_socket.recv(4096).decode("utf-8")
            if not data:
                break
            buffer += data
            
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                if not line.strip():
                    continue
                        
                # print(f"[Socket - {addr}] Received data: {line}")
                try:
                    content = json.loads(line)
                    transaction_id = content.get("transaction_id", None)
                    status = content.get("status", None)
                    emoji = content.get("emoji", None)
                    text = content.get("text", None)
                    rgbled = content.get("RGB", None)
                    brightness = content.get("brightness", None)
                    scroll_speed = content.get("scroll_speed", None)
                    scroll_sync = content.get("scroll_sync", None)
                    response_to_client = content.get("response", None)
                    battery_level = content.get("battery_level", None)
                    battery_color = content.get("battery_color", None)
                    image_path = content.get("image", None)
                    network_connected = content.get("network_connected", None)
                    rag_icon_visible = content.get("rag_icon_visible", None)
                    image_icon_visible = content.get("image_icon_visible", None)
                    capture_image_path = content.get("capture_image_path", None)
                    trigger_camera_capture = content.get("camera_capture", None)
                    # boolean to enable camera mode
                    set_camera_mode = content.get("camera_mode", None)

                    if rgbled:
                        rgb255_tuple = ColorUtils.get_rgb255_from_any(rgbled)
                        whisplay.set_rgb_fade(*rgb255_tuple, duration_ms=500)
                    
                    if battery_color:
                        battery_tuple = ColorUtils.get_rgb255_from_any(battery_color)
                    else:
                        battery_tuple = (0, 0, 0)
                        
                    if brightness:
                        whisplay.set_backlight(brightness)
                        
                    if capture_image_path is not None:
                        camera_capture_image_path = capture_image_path
                    
                    if set_camera_mode is not None:
                        if set_camera_mode:
                            print("[Camera] Entering camera mode...")
                            camera_mode = True
                            camera_thread = CameraThread(whisplay, camera_capture_image_path)
                            camera_thread.start()
                        else:
                            print("[Camera] Exiting camera mode...")
                            if camera_thread is not None:
                                camera_thread.stop()
                                camera_thread = None
                            camera_mode = False

                    if trigger_camera_capture:
                        print("[Camera] Capturing image by command...")
                        if camera_thread is not None:
                            camera_thread.capture()
                            notification = {"event": "camera_capture"}
                            send_to_all_clients(notification)

                    if (text is not None) or (status is not None) or (emoji is not None) or \
                       (battery_level is not None) or (battery_color is not None) or \
                              (image_path is not None) or (network_connected is not None) or \
                            (rag_icon_visible is not None) or (image_icon_visible is not None) or (scroll_sync is not None):
                        update_display_data(status=status, emoji=emoji,
                                     text=text, scroll_speed=scroll_speed, scroll_sync=scroll_sync,
                                     battery_level=battery_level, battery_color=battery_tuple,
                                                 image_path=image_path, network_connected=network_connected,
                                                 rag_icon_visible=rag_icon_visible,
                                         image_icon_visible=image_icon_visible,
                                                 transaction_id=transaction_id)

                    client_socket.send(b"OK\n")
                    if response_to_client:
                        try:
                            response_bytes = json.dumps({"response": response_to_client}).encode("utf-8") + b"\n"
                            client_socket.send(response_bytes)
                            print(f"[Socket - {addr}] Sent response: {response_to_client}")
                        except Exception as e:
                            print(f"[Socket - {addr}] Response sending error: {e}")
                            
                except json.JSONDecodeError:
                    client_socket.send(b"ERROR: invalid JSON\n")
                except Exception as e:
                    print(f"[Socket - {addr}] Data processing error: {e}")
                    client_socket.send(f"ERROR: {e}\n".encode("utf-8"))

    except Exception as e:
        print(f"[Socket - {addr}] Connection error: {e}")
    finally:
        print(f"[Socket] Client {addr} disconnected")
        del clients[addr]
        client_socket.close()

def start_socket_server(render_thread, host='0.0.0.0', port=12345):
    # Register button events
    whisplay.on_button_press(on_button_pressed)
    whisplay.on_button_release(on_button_release)

    server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_socket.bind((host, port))
    server_socket.listen(5)  # Allow more connections
    print(f"[Socket] Listening on {host}:{port} ...")

    try:
        while True:
            client_socket, addr = server_socket.accept()
            client_thread = threading.Thread(target=handle_client, 
                                           args=(client_socket, addr, whisplay))
            client_thread.daemon = True
            client_thread.start()
    except KeyboardInterrupt:
        print("[Socket] Server stopped")
    finally:
        render_thread.stop()
        server_socket.close()


if __name__ == "__main__":
    whisplay = WhisplayBoard()
    print(f"[LCD] Initialization finished: {whisplay.LCD_WIDTH}x{whisplay.LCD_HEIGHT}")
    
    # read CUSTOM_FONT_PATH from environment variable
    custom_font_path = os.getenv("CUSTOM_FONT_PATH", None)
    
    # start render thread
    render_thread = RenderThread(whisplay, custom_font_path or "NotoSansSC-Bold.ttf", fps=30)
    render_thread.start()
    start_socket_server(render_thread, host='0.0.0.0', port=12345)
    
    def cleanup_and_exit(signum, frame):
        print("[System] Exiting...")
        render_thread.stop()
        whisplay.cleanup()
        sys.exit(0)
        
    signal.signal(signal.SIGTERM, cleanup_and_exit)
    signal.signal(signal.SIGINT, cleanup_and_exit)
    signal.signal(signal.SIGKILL, cleanup_and_exit)
    signal.signal(signal.SIGQUIT, cleanup_and_exit)
    signal.signal(signal.SIGSTOP, cleanup_and_exit)
    try:
        # Keep the main thread alive
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        cleanup_and_exit(None, None)
    
