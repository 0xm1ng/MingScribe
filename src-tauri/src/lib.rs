use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::Write;
use std::process::Command;

/// 把任意可转格式转成 EPUB。
///
/// 入参为源文件字节的 base64 与扩展名；函数负责：
///   1. 把字节写到系统临时目录的 `mingscribe-in.<ext>`；
///   2. 调用 Calibre 的 `ebook-convert` 生成 `mingscribe-out.epub`；
///   3. 读取 EPUB 字节，base64 回传；失败时清理并返回可读错误。
///
/// 走 base64（而非文件路径）是为了避免引入额外的 FS / 对话框插件——
/// 浏览器侧拿到的是 File 对象，没有本地路径，base64 直传最简单。
#[tauri::command]
fn convert_to_epub(input_b64: String, input_ext: String) -> Result<String, String> {
    let bytes = STANDARD
        .decode(&input_b64)
        .map_err(|e| format!("解码输入字节失败：{}", e))?;

    let tmp = std::env::temp_dir();
    let in_path = tmp.join(format!("mingscribe-in.{}", input_ext));
    let out_path = tmp.join("mingscribe-out.epub");

    // 先清掉上一次的残留产物
    let _ = std::fs::remove_file(&out_path);

    {
        let mut f = std::fs::File::create(&in_path).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    let status = Command::new("ebook-convert")
        .arg(&in_path)
        .arg(&out_path)
        .status()
        .map_err(|e| {
            format!(
                "无法启动 ebook-convert：{}（请确认已安装 Calibre，且其可执行文件在 PATH 中）",
                e
            )
        })?;

    // 转换完成，源文件可删
    let _ = std::fs::remove_file(&in_path);

    if !status.success() {
        return Err(
            "ebook-convert 退出码非零：文件可能已加密（DRM 保护）或格式不受支持".to_string(),
        );
    }

    let epub = std::fs::read(&out_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out_path);

    Ok(STANDARD.encode(epub))
}

/// 用系统默认浏览器打开一个外部链接。
///
/// 为什么需要：Tauri 的 webview 里 `window.open('https://…')` 默认打不开系统浏览器，
/// 而「发现新版本 → 去下载」必须能跳出去。这里刻意**不引入 opener 插件**——
/// 直接用系统自带的打开命令就行，少一个依赖、少一份后续升级负担。
///
/// 安全约束：只放行 http / https，避免被利用去启动本地程序或访问 file://。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("只允许打开 http/https 链接".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // "start" 是 cmd 的内置命令；中间那个空字符串是 start 的窗口标题参数，不能省
        Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![convert_to_epub, open_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
