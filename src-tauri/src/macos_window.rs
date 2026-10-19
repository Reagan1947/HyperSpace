//! macOS window tiling sizes a window from `contentLayoutRect`.
//!
//! Overlay title bars use a full-size content view, but AppKit still reports
//! `contentLayoutRect` as the frame minus the title bar. Tile placement then
//! grows the frame by that inset, so a bottom corner tile sticks out above
//! the region macOS assigned.

use std::ffi::c_void;
use std::sync::Once;

use objc2::ffi::NSUInteger;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{ffi, msg_send, sel};
use objc2_core_foundation::CGRect;

/// `NSWindowStyleMaskFullSizeContentView`.
const FULL_SIZE_CONTENT_VIEW: NSUInteger = 1 << 15;

pub fn fit_overlay_titlebar_tiling(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }

    // SAFETY: `ns_window` is the live NSWindow pointer for this Tauri window.
    let window: &AnyObject = unsafe { &*ns_window.cast() };
    install_content_layout_override(window.class());
}

fn install_content_layout_override(class: &AnyClass) {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| {
        let selector = sel!(contentLayoutRect);
        let Some(superclass) = class.superclass() else {
            return;
        };
        let Some(inherited) = superclass.instance_method(selector) else {
            return;
        };
        // Adding the method on the existing window class avoids `object_setClass`,
        // which breaks NSWindow's dynamic properties.
        let types = unsafe { ffi::method_getTypeEncoding(inherited) };
        let imp: unsafe extern "C-unwind" fn(&AnyObject, Sel) -> CGRect = content_layout_rect;
        let added = unsafe {
            ffi::class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                selector,
                std::mem::transmute(imp),
                types,
            )
        };
        if !added.as_bool() {
            eprintln!("HyperSpace: could not install macOS tiling size override");
        }
    });
}

unsafe extern "C-unwind" fn content_layout_rect(this: &AnyObject, cmd: Sel) -> CGRect {
    let superclass = this.class().superclass().expect("window superclass");
    let original = superclass
        .instance_method(sel!(contentLayoutRect))
        .expect("NSWindow contentLayoutRect");
    let original: unsafe extern "C-unwind" fn(&AnyObject, Sel) -> CGRect =
        std::mem::transmute(original.implementation());
    let mut rect = unsafe { original(this, cmd) };
    let style_mask: NSUInteger = unsafe { msg_send![this, styleMask] };
    if style_mask & FULL_SIZE_CONTENT_VIEW == 0 {
        return rect;
    }
    let frame: CGRect = unsafe { msg_send![this, frame] };
    rect.origin.y = 0.0;
    rect.size.height = frame.size.height;
    rect
}
