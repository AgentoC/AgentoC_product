#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#define _UNICODE
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <msi.h>
#include <msiquery.h>
#include <shobjidl.h>
#include <shlwapi.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <filesystem>
#include <memory>
#include <process.h>
#include <string>
#include <vector>
#include <cwctype>
#include <iterator>
#include <new>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "msi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "shlwapi.lib")

namespace {

constexpr wchar_t kWindowClass[] = L"AgentoC.EmbeddedMsiInstaller";
constexpr wchar_t kWindowTitle[] = L"AgentoC Setup";
constexpr UINT kInstallMessage = WM_APP + 20;
constexpr UINT kRestoreInstallerWindow = WM_APP + 21;
constexpr UINT kButtonWelcome = 4101;
constexpr UINT kButtonBack = 4102;
constexpr UINT kButtonBrowse = 4103;
constexpr UINT kButtonInstall = 4104;
constexpr UINT kButtonCancel = 4105;
constexpr UINT kButtonFinish = 4106;
constexpr UINT kButtonLaunchOption = 4107;
constexpr UINT kInstallEdit = 4201;

enum class Page { Welcome, Location, Installing, Complete, Failed };

struct InstallerState {
    HWND window = nullptr;
    HWND pathEdit = nullptr;
    HWND welcomeButton = nullptr;
    HWND backButton = nullptr;
    HWND browseButton = nullptr;
    HWND installButton = nullptr;
    HWND cancelButton = nullptr;
    HWND finishButton = nullptr;
    HWND launchOption = nullptr;
    Page page = Page::Welcome;
    bool chinese = false;
    bool closing = false;
    bool installSucceeded = false;
    bool openAfterInstall = true;
    int progress = 0;
    float scale = 1.0f;
    std::wstring installPath;
    std::wstring currentAction;
    std::wstring errorDetail;
    Gdiplus::Image* logo = nullptr;
    HFONT font = nullptr;
};

InstallerState g;
HINSTANCE gModule = nullptr;
HANDLE gStartEvent = nullptr;
HANDLE gExitEvent = nullptr;
HANDLE gUiReadyEvent = nullptr;
HANDLE gUiThread = nullptr;
unsigned int gUiThreadId = 0;
std::atomic<HWND> gUiWindow{nullptr};
std::atomic_bool gCancelRequested{false};
std::atomic_bool gInstallEnded{false};
std::atomic_bool gHasErrorDetail{false};
std::atomic_int gInstallResult{-1};
std::atomic_int gProgressValue{0};
std::atomic_int gProgressTicks{0};
std::atomic_int gProgressTotal{0};
ULONG_PTR gGdiPlusToken = 0;
std::wstring gResourceDirectory;

Gdiplus::Color Color(BYTE r, BYTE green, BYTE b) { return Gdiplus::Color(255, r, green, b); }
Gdiplus::Color AlphaColor(BYTE alpha, BYTE r, BYTE green, BYTE b) { return Gdiplus::Color(alpha, r, green, b); }
int Px(float value) { return static_cast<int>(std::lround(value * g.scale)); }

constexpr int kDesignWidth = 890;
constexpr int kDesignHeight = 590;
constexpr DWORD kInstallerWindowStyle = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;

float ScaleForMonitor(HMONITOR monitor, UINT dpi) {
    const float requestedScale = dpi > 0 ? static_cast<float>(dpi) / 96.0f : 1.0f;
    MONITORINFO info{sizeof(info)};
    if (!monitor || !GetMonitorInfoW(monitor, &info)) return requestedScale;

    const float availableWidth = static_cast<float>(info.rcWork.right - info.rcWork.left - 48);
    const float availableHeight = static_cast<float>(info.rcWork.bottom - info.rcWork.top - 72);
    const float fitScale = std::min(availableWidth / kDesignWidth, availableHeight / kDesignHeight);
    return std::max(0.5f, std::min(requestedScale, fitScale));
}

RECT WindowBoundsForScale(float scale, UINT dpi) {
    RECT bounds{0, 0, static_cast<LONG>(std::lround(kDesignWidth * scale)),
        static_cast<LONG>(std::lround(kDesignHeight * scale))};
    AdjustWindowRectExForDpi(&bounds, kInstallerWindowStyle, FALSE, 0, dpi);
    return bounds;
}

void ResizeWindowForDpi(HWND window, const RECT* suggested, UINT dpi) {
    HMONITOR monitor = suggested
        ? MonitorFromRect(suggested, MONITOR_DEFAULTTONEAREST)
        : MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
    g.scale = ScaleForMonitor(monitor, dpi);

    RECT bounds = WindowBoundsForScale(g.scale, dpi);
    const int width = bounds.right - bounds.left;
    const int height = bounds.bottom - bounds.top;
    MONITORINFO info{sizeof(info)};
    if (!monitor || !GetMonitorInfoW(monitor, &info)) return;

    int x = info.rcWork.left + (info.rcWork.right - info.rcWork.left - width) / 2;
    int y = info.rcWork.top + (info.rcWork.bottom - info.rcWork.top - height) / 2;
    if (suggested) {
        x = suggested->left + ((suggested->right - suggested->left) - width) / 2;
        y = suggested->top + ((suggested->bottom - suggested->top) - height) / 2;
    }
    const int workLeft = static_cast<int>(info.rcWork.left);
    const int workTop = static_cast<int>(info.rcWork.top);
    const int workRight = static_cast<int>(info.rcWork.right);
    const int workBottom = static_cast<int>(info.rcWork.bottom);
    x = std::clamp(x, workLeft, std::max(workLeft, workRight - width));
    y = std::clamp(y, workTop, std::max(workTop, workBottom - height));
    SetWindowPos(window, nullptr, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
}

std::wstring CopyRecordField(MSIHANDLE record, UINT field) {
    DWORD length = 0;
    UINT result = MsiRecordGetStringW(record, field, nullptr, &length);
    if (result != ERROR_MORE_DATA && result != ERROR_SUCCESS) return {};
    std::vector<wchar_t> buffer(static_cast<size_t>(length) + 2, L'\0');
    DWORD capacity = static_cast<DWORD>(buffer.size());
    result = MsiRecordGetStringW(record, field, buffer.data(), &capacity);
    if (result != ERROR_SUCCESS) return {};
    return std::wstring(buffer.data());
}

std::wstring Text(const wchar_t* en, const wchar_t* zh) {
    return g.chinese ? zh : en;
}

void FillRounded(Gdiplus::Graphics& graphics, const Gdiplus::RectF& rect, float radius, const Gdiplus::Brush& brush) {
    const float d = radius * 2.0f;
    Gdiplus::GraphicsPath path;
    path.AddArc(rect.X, rect.Y, d, d, 180, 90);
    path.AddArc(rect.X + rect.Width - d, rect.Y, d, d, 270, 90);
    path.AddArc(rect.X + rect.Width - d, rect.Y + rect.Height - d, d, d, 0, 90);
    path.AddArc(rect.X, rect.Y + rect.Height - d, d, d, 90, 90);
    path.CloseFigure();
    graphics.FillPath(&brush, &path);
}

void DrawRoundedOutline(Gdiplus::Graphics& graphics, const Gdiplus::RectF& rect, float radius, const Gdiplus::Pen& pen) {
    const float d = radius * 2.0f;
    Gdiplus::GraphicsPath path;
    path.AddArc(rect.X, rect.Y, d, d, 180, 90);
    path.AddArc(rect.X + rect.Width - d, rect.Y, d, d, 270, 90);
    path.AddArc(rect.X + rect.Width - d, rect.Y + rect.Height - d, d, d, 0, 90);
    path.AddArc(rect.X, rect.Y + rect.Height - d, d, d, 90, 90);
    path.CloseFigure();
    graphics.DrawPath(&pen, &path);
}

void DrawText(Gdiplus::Graphics& graphics, const std::wstring& value, float x, float y, float width,
              float size, Gdiplus::Color color, bool semibold = false, Gdiplus::StringAlignment alignment = Gdiplus::StringAlignmentNear) {
    Gdiplus::FontFamily family(L"Segoe UI");
    Gdiplus::Font font(&family, size, semibold ? Gdiplus::FontStyleBold : Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
    Gdiplus::SolidBrush brush(color);
    Gdiplus::StringFormat format;
    format.SetAlignment(alignment);
    format.SetLineAlignment(Gdiplus::StringAlignmentNear);
    format.SetTrimming(Gdiplus::StringTrimmingEllipsisCharacter);
    format.SetFormatFlags(Gdiplus::StringFormatFlagsLineLimit);
    graphics.DrawString(value.c_str(), static_cast<INT>(value.size()), &font,
        Gdiplus::RectF(x, y, width, size * 3.0f), &format, &brush);
}

RECT ClientRect(HWND window) {
    RECT rect{};
    GetClientRect(window, &rect);
    return rect;
}

RECT ButtonRect(HWND button) {
    RECT rect{};
    GetWindowRect(button, &rect);
    MapWindowPoints(nullptr, g.window, reinterpret_cast<POINT*>(&rect), 2);
    return rect;
}

void Position(HWND control, int x, int y, int width, int height, bool visible = true) {
    if (!control) return;
    SetWindowPos(control, nullptr, x, y, width, height,
        SWP_NOZORDER | SWP_NOACTIVATE | (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
}

HWND MakeButton(HWND parent, UINT id, const std::wstring& label, DWORD buttonStyle = BS_OWNERDRAW) {
    return CreateWindowExW(0, L"BUTTON", label.c_str(), WS_CHILD | WS_TABSTOP | buttonStyle,
        0, 0, 1, 1, parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), gModule, nullptr);
}

void SetPage(Page page) {
    g.page = page;
    if (g.pathEdit) {
        const bool visible = page == Page::Location;
        ShowWindow(g.pathEdit, visible ? SW_SHOW : SW_HIDE);
        if (visible) SetFocus(g.pathEdit);
    }
    if (g.welcomeButton) ShowWindow(g.welcomeButton, page == Page::Welcome ? SW_SHOW : SW_HIDE);
    if (g.backButton) ShowWindow(g.backButton, page == Page::Location ? SW_SHOW : SW_HIDE);
    if (g.browseButton) ShowWindow(g.browseButton, page == Page::Location ? SW_SHOW : SW_HIDE);
    if (g.installButton) ShowWindow(g.installButton, page == Page::Location ? SW_SHOW : SW_HIDE);
    if (g.cancelButton) ShowWindow(g.cancelButton, (page == Page::Location || page == Page::Installing) ? SW_SHOW : SW_HIDE);
    if (g.finishButton) ShowWindow(g.finishButton, (page == Page::Complete || page == Page::Failed) ? SW_SHOW : SW_HIDE);
    if (g.launchOption) ShowWindow(g.launchOption, page == Page::Location ? SW_SHOW : SW_HIDE);
    if (g.window) {
        InvalidateRect(g.window, nullptr, TRUE);
        UpdateWindow(g.window);
    }
}

void LayoutControls() {
    if (!g.window) return;
    RECT client = ClientRect(g.window);
    const int width = client.right;
    const int height = client.bottom;
    const int left = Px(274);
    const int margin = Px(42);
    const int footerY = height - Px(68);
    const int buttonW = Px(132);
    const int buttonH = Px(42);
    const int gap = Px(10);
    const int right = width - margin;

    Position(g.pathEdit, left + margin, Px(270), width - left - margin * 2 - Px(120), Px(46), g.page == Page::Location);
    Position(g.browseButton, right - Px(108), Px(270), Px(108), Px(46), g.page == Page::Location);
    Position(g.launchOption, left + margin, Px(334), width - left - margin * 2, Px(28), g.page == Page::Location);
    Position(g.welcomeButton, right - buttonW, footerY, buttonW, buttonH, g.page == Page::Welcome);
    Position(g.installButton, right - buttonW, footerY, buttonW, buttonH, g.page == Page::Location);
    Position(g.backButton, right - buttonW * 2 - gap, footerY, buttonW, buttonH, g.page == Page::Location);
    Position(g.cancelButton, left + margin, footerY, buttonW, buttonH,
        g.page == Page::Location || g.page == Page::Installing);
    Position(g.finishButton, right - buttonW, footerY, buttonW, buttonH,
        g.page == Page::Complete || g.page == Page::Failed);
    if (g.installButton && g.page == Page::Location) {
        const int length = GetWindowTextLengthW(g.pathEdit);
        EnableWindow(g.installButton, length > 0);
    }
}

void BrowseForFolder() {
    IFileOpenDialog* dialog = nullptr;
    HRESULT result = CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&dialog));
    if (FAILED(result) || !dialog) {
        g.errorDetail = Text(L"Windows could not open the folder picker.", L"Windows 无法打开文件夹选择器。");
        InvalidateRect(g.window, nullptr, TRUE);
        return;
    }

    FILEOPENDIALOGOPTIONS options{};
    if (SUCCEEDED(dialog->GetOptions(&options))) {
        dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    }
    dialog->SetTitle(g.chinese ? L"选择 AgentoC 安装文件夹" : L"Choose the AgentoC installation folder");
    result = dialog->Show(g.window);
    if (SUCCEEDED(result)) {
        IShellItem* item = nullptr;
        if (SUCCEEDED(dialog->GetResult(&item)) && item) {
            PWSTR path = nullptr;
            if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) {
                SetWindowTextW(g.pathEdit, path);
                CoTaskMemFree(path);
            }
            item->Release();
        }
    }
    dialog->Release();
}

bool NormalizeInstallPath(std::wstring value, std::wstring& normalized, std::wstring& error) {
    while (!value.empty() && iswspace(value.front())) value.erase(value.begin());
    while (!value.empty() && iswspace(value.back())) value.pop_back();
    if (value.empty()) {
        error = Text(L"Choose an installation folder to continue.", L"请选择安装文件夹后继续。");
        return false;
    }
    if (value.find_first_of(L"\"<>|?*") != std::wstring::npos) {
        error = Text(L"The folder path contains a character Windows does not allow.", L"文件夹路径包含 Windows 不允许的字符。");
        return false;
    }
    const std::filesystem::path supplied(value);
    if (!supplied.is_absolute()) {
        error = Text(L"Enter a full path, such as G:\\AgentoCapp.", L"请输入完整路径，例如 G:\\AgentoCapp。");
        return false;
    }

    std::vector<wchar_t> fullPath(32768, L'\0');
    const DWORD fullLength = GetFullPathNameW(value.c_str(), static_cast<DWORD>(fullPath.size()), fullPath.data(), nullptr);
    if (fullLength == 0 || fullLength >= fullPath.size()) {
        error = Text(L"Windows could not resolve this folder path.", L"Windows 无法识别此文件夹路径。");
        return false;
    }
    normalized.assign(fullPath.data(), fullLength);
    while (normalized.size() > 3 && (normalized.back() == L'\\' || normalized.back() == L'/')) normalized.pop_back();

    DWORD attributes = GetFileAttributesW(normalized.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        error = Text(L"The selected path is a file. Choose a folder.", L"所选路径是文件，请选择文件夹。");
        return false;
    }
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        std::filesystem::path parent = supplied.parent_path();
        if (parent.empty() || !std::filesystem::exists(parent)) {
            error = Text(L"Create or choose a parent folder before using this path.", L"请先创建或选择此路径的上级文件夹。");
            return false;
        }
    }
    wchar_t volumeRoot[MAX_PATH]{};
    if (GetVolumePathNameW(normalized.c_str(), volumeRoot, MAX_PATH) && _wcsicmp(normalized.c_str(), volumeRoot) == 0) {
        error = Text(L"Choose a folder inside the drive, not the drive root.", L"请选择磁盘内的文件夹，不要选择整个磁盘根目录。");
        return false;
    }
    if (normalized.back() != L'\\') normalized.push_back(L'\\');
    return true;
}

void DrawBrandPanel(Gdiplus::Graphics& graphics, const RECT& client, float width) {
    Gdiplus::RectF panel(0, 0, width, static_cast<float>(client.bottom));
    Gdiplus::LinearGradientBrush background(panel, Color(19, 38, 58), Color(35, 65, 91), Gdiplus::LinearGradientModeVertical);
    graphics.FillRectangle(&background, panel);

    Gdiplus::SolidBrush glow(AlphaColor(17, 255, 255, 255));
    graphics.FillEllipse(&glow, -width * 0.48f, 35.0f, width * 1.32f, width * 1.32f);
    Gdiplus::SolidBrush accent(AlphaColor(45, 105, 218, 206));
    graphics.FillEllipse(&accent, width * 0.48f, 180.0f, width * 0.9f, width * 0.9f);

    if (g.logo && g.logo->GetLastStatus() == Gdiplus::Ok) {
        const float logoSize = Px(108);
        graphics.DrawImage(g.logo, Gdiplus::RectF(Px(44), Px(60), logoSize, logoSize));
    }
    DrawText(graphics, L"AgentoC", Px(42), Px(190), width - Px(72), Px(30), Color(250, 252, 255), true);
    DrawText(graphics, Text(L"Your local AI workbench", L"你的本地 AI 工作台"), Px(44), Px(236), width - Px(76), Px(16), Color(193, 211, 224));

    Gdiplus::SolidBrush divider(AlphaColor(48, 255, 255, 255));
    graphics.FillRectangle(&divider, static_cast<Gdiplus::REAL>(Px(44)), static_cast<Gdiplus::REAL>(Px(292)), width - Px(88), static_cast<Gdiplus::REAL>(Px(1)));
    DrawText(graphics, Text(L"Private by design", L"为私有而设计"), Px(44), Px(318), width - Px(76), Px(14), Color(222, 233, 241), true);
    DrawText(graphics, Text(L"Manage models, devices, and local runtimes in one place.", L"在一个地方管理模型、设备和本地运行环境。"),
        Px(44), Px(344), width - Px(80), Px(13), Color(177, 198, 214));

    DrawText(graphics, Text(L"AGENTOC  ·  WINDOWS", L"AGENTOC  ·  WINDOWS"), Px(44), client.bottom - Px(38), width - Px(72), Px(10), Color(149, 177, 197), true);
}

void DrawMainContent(Gdiplus::Graphics& graphics, const RECT& client, float left) {
    const float x = left + Px(42);
    const float width = client.right - x - Px(42);
    const Gdiplus::Color ink = Color(30, 38, 50);
    const Gdiplus::Color muted = Color(105, 116, 130);
    const Gdiplus::Color accent = Color(53, 96, 230);
    const float y = Px(44);

    std::wstring eyebrow = Text(L"AGENTOC SETUP", L"AGENTOC 安装程序");
    DrawText(graphics, eyebrow, x, y, width, Px(11), accent, true);

    switch (g.page) {
    case Page::Welcome: {
        DrawText(graphics, Text(L"Welcome to AgentoC", L"欢迎使用 AgentoC"), x, y + Px(44), width, Px(31), ink, true);
        DrawText(graphics, Text(L"A calm, secure place to manage your local AI workbench.", L"在这里轻松、安全地管理本地 AI 工作台。"),
            x, y + Px(98), width, Px(15), muted);

        Gdiplus::SolidBrush cardFill(Color(246, 248, 251));
        FillRounded(graphics, Gdiplus::RectF(x, y + Px(158), width, Px(116)), Px(12), cardFill);
        Gdiplus::SolidBrush iconFill(Color(229, 238, 255));
        FillRounded(graphics, Gdiplus::RectF(x + Px(18), y + Px(180), Px(38), Px(38)), Px(11), iconFill);
        DrawText(graphics, L"✓", x + Px(18), y + Px(187), Px(38), Px(20), accent, true, Gdiplus::StringAlignmentCenter);
        DrawText(graphics, Text(L"Your services keep running in the background", L"管理窗口关闭后，后台服务仍会运行"),
            x + Px(72), y + Px(179), width - Px(92), Px(14), ink, true);
        DrawText(graphics, Text(L"The desktop manager opens as your regular Windows user.", L"桌面管理器会以当前普通 Windows 用户身份运行。"),
            x + Px(72), y + Px(205), width - Px(92), Px(12), muted);

        DrawText(graphics, Text(L"Next, choose the folder for the application files.", L"下一步，请选择应用程序文件的安装文件夹。"),
            x, y + Px(306), width, Px(13), muted);
        break;
    }
    case Page::Location: {
        DrawText(graphics, Text(L"Choose an install folder", L"选择安装文件夹"), x, y + Px(44), width, Px(29), ink, true);
        DrawText(graphics, Text(L"Select a folder for the AgentoC application files.", L"请选择 AgentoC 应用程序文件的安装位置。"),
            x, y + Px(96), width, Px(14), muted);
        DrawText(graphics, Text(L"You can choose an existing folder or create a new one.", L"可以选择已有文件夹，也可以新建文件夹。"),
            x, y + Px(122), width, Px(13), muted);
        DrawText(graphics, Text(L"Installation folder", L"安装文件夹"), x, y + Px(202), width, Px(12), ink, true);

        Gdiplus::SolidBrush noteFill(Color(246, 248, 251));
        FillRounded(graphics, Gdiplus::RectF(x, y + Px(319), width, Px(50)), Px(9), noteFill);
        const std::wstring note = g.errorDetail.empty()
            ? Text(L"Protected service data remains in C:\\ProgramData\\AgentoC.", L"受保护的服务数据仍保存在 C:\\ProgramData\\AgentoC。")
            : g.errorDetail;
        DrawText(graphics, note, x + Px(14), y + Px(335), width - Px(28), Px(12),
            g.errorDetail.empty() ? muted : Color(166, 66, 52));
        break;
    }
    case Page::Installing: {
        DrawText(graphics, Text(L"Installing AgentoC", L"正在安装 AgentoC"), x, y + Px(44), width, Px(29), ink, true);
        DrawText(graphics, Text(L"This may take a few minutes. Keep this window open.", L"这可能需要几分钟，请保持此窗口打开。"),
            x, y + Px(96), width, Px(14), muted);

        const float progressY = y + Px(190);
        Gdiplus::SolidBrush track(Color(232, 236, 242));
        FillRounded(graphics, Gdiplus::RectF(x, progressY, width, Px(10)), Px(5), track);
        if (g.progress > 0) {
            Gdiplus::SolidBrush fill(accent);
            FillRounded(graphics, Gdiplus::RectF(x, progressY, std::max(static_cast<float>(Px(18)), width * g.progress / 100.0f), Px(10)), Px(5), fill);
        } else {
            Gdiplus::SolidBrush fill(accent);
            FillRounded(graphics, Gdiplus::RectF(x, progressY, std::max(static_cast<float>(Px(36)), width * 0.22f), Px(10)), Px(5), fill);
        }
        std::wstring status = g.currentAction.empty() ? Text(L"Preparing installation…", L"正在准备安装…") : g.currentAction;
        DrawText(graphics, status, x, progressY + Px(26), width, Px(12), muted);
        break;
    }
    case Page::Complete: {
        Gdiplus::SolidBrush successFill(Color(229, 247, 239));
        FillRounded(graphics, Gdiplus::RectF(x, y + Px(44), Px(52), Px(52)), Px(16), successFill);
        DrawText(graphics, L"✓", x, y + Px(54), Px(52), Px(25), Color(27, 143, 91), true, Gdiplus::StringAlignmentCenter);
        DrawText(graphics, Text(L"AgentoC is ready", L"AgentoC 已准备就绪"), x, y + Px(124), width, Px(29), ink, true);
        DrawText(graphics, Text(L"Installation completed successfully. You can open the desktop manager from the Start menu.",
            L"安装已成功完成。你可以从开始菜单打开桌面管理器。"), x, y + Px(176), width, Px(14), muted);
        break;
    }
    case Page::Failed: {
        Gdiplus::SolidBrush failFill(Color(255, 239, 234));
        FillRounded(graphics, Gdiplus::RectF(x, y + Px(44), Px(52), Px(52)), Px(16), failFill);
        DrawText(graphics, L"!", x, y + Px(53), Px(52), Px(25), Color(190, 63, 37), true, Gdiplus::StringAlignmentCenter);
        DrawText(graphics, Text(L"Installation could not finish", L"安装未能完成"), x, y + Px(124), width, Px(26), ink, true);
        DrawText(graphics, Text(L"Windows Installer rolled back the incomplete changes. Your existing data is preserved.",
            L"Windows Installer 已回滚未完成的更改，现有数据已保留。"), x, y + Px(170), width, Px(14), muted);
        DrawText(graphics, g.errorDetail.empty() ? Text(L"See the Windows Installer log for details.", L"请查看 Windows Installer 日志了解详情。") : g.errorDetail,
            x, y + Px(222), width, Px(12), Color(141, 67, 57));
        break;
    }
    }
}

void UpdateWindowTitle() {
    if (!g.window) return;
    if (g.page == Page::Installing) SetWindowTextW(g.window, Text(L"Installing AgentoC", L"正在安装 AgentoC").c_str());
    else if (g.page == Page::Complete) SetWindowTextW(g.window, Text(L"AgentoC setup complete", L"AgentoC 安装完成").c_str());
    else if (g.page == Page::Failed) SetWindowTextW(g.window, Text(L"AgentoC setup", L"AgentoC 安装程序").c_str());
    else SetWindowTextW(g.window, kWindowTitle);
}

void DrawOwnerButton(const DRAWITEMSTRUCT* item) {
    HDC dc = item->hDC;
    RECT rect = item->rcItem;
    const bool primary = item->CtlID == kButtonWelcome || item->CtlID == kButtonInstall || item->CtlID == kButtonFinish;
    const bool cancel = item->CtlID == kButtonCancel;
    const bool disabled = (item->itemState & ODS_DISABLED) != 0;
    const bool pressed = (item->itemState & ODS_SELECTED) != 0;
    const bool focused = (item->itemState & ODS_FOCUS) != 0;
    const bool hot = (item->itemState & ODS_HOTLIGHT) != 0;

    Gdiplus::Graphics graphics(dc);
    graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    if (item->CtlID == kButtonLaunchOption) {
        Gdiplus::RectF checkbox(static_cast<float>(rect.left + Px(2)), static_cast<float>(rect.top + Px(4)), Px(18), Px(18));
        Gdiplus::SolidBrush fill((item->itemState & ODS_CHECKED) ? Color(53, 96, 230) : Color(255, 255, 255));
        FillRounded(graphics, checkbox, Px(4), fill);
        Gdiplus::Pen border((item->itemState & ODS_CHECKED) ? Color(53, 96, 230) : Color(178, 186, 197), static_cast<float>(Px(1.2f)));
        DrawRoundedOutline(graphics, checkbox, Px(4), border);
        if (item->itemState & ODS_CHECKED) {
            Gdiplus::Pen check(Color(255, 255, 255), static_cast<float>(Px(1.8f)));
            check.SetStartCap(Gdiplus::LineCapRound);
            check.SetEndCap(Gdiplus::LineCapRound);
            graphics.DrawLine(&check, checkbox.X + Px(4), checkbox.Y + Px(9), checkbox.X + Px(8), checkbox.Y + Px(13));
            graphics.DrawLine(&check, checkbox.X + Px(8), checkbox.Y + Px(13), checkbox.X + Px(15), checkbox.Y + Px(5));
        }
        wchar_t label[128]{};
        GetWindowTextW(item->hwndItem, label, static_cast<int>(std::size(label)));
        DrawText(graphics, label, checkbox.X + Px(30), checkbox.Y + Px(2), rect.right - checkbox.X - Px(40), Px(13), Color(47, 57, 71), true);
        if (item->itemState & ODS_FOCUS) {
            Gdiplus::Pen focus(Color(80, 117, 235), static_cast<float>(Px(1.2f)));
            Gdiplus::RectF focusRect(static_cast<float>(rect.left + Px(1)), static_cast<float>(rect.top + Px(1)),
                static_cast<float>(rect.right - rect.left - Px(2)), static_cast<float>(rect.bottom - rect.top - Px(2)));
            DrawRoundedOutline(graphics, focusRect, Px(5), focus);
        }
        return;
    }
    Gdiplus::RectF button(static_cast<float>(rect.left + Px(1)), static_cast<float>(rect.top + Px(1)),
        static_cast<float>(rect.right - rect.left - Px(2)), static_cast<float>(rect.bottom - rect.top - Px(2)));
    Gdiplus::Color fill = primary ? Color(48, 91, 224) : Color(240, 243, 247);
    Gdiplus::Color foreground = primary ? Color(255, 255, 255) : Color(47, 57, 71);
    if (disabled) { fill = Color(230, 233, 238); foreground = Color(147, 155, 166); }
    else if (pressed) { fill = primary ? Color(35, 72, 195) : Color(222, 228, 236); }
    else if (hot) { fill = primary ? Color(39, 79, 211) : Color(230, 235, 242); }
    if (cancel && g.page == Page::Installing) { fill = Color(255, 255, 255); foreground = Color(91, 102, 118); }
    Gdiplus::SolidBrush brush(fill);
    FillRounded(graphics, button, Px(9), brush);
    if (focused) {
        Gdiplus::Pen focus(Color(80, 117, 235), static_cast<float>(Px(1.5f)));
        Gdiplus::RectF focusRect(button.X + Px(3), button.Y + Px(3), button.Width - Px(6), button.Height - Px(6));
        DrawRoundedOutline(graphics, focusRect, Px(7), focus);
    }
    wchar_t label[96]{};
    GetWindowTextW(item->hwndItem, label, static_cast<int>(std::size(label)));
    DrawText(graphics, label, button.X + Px(5), button.Y + button.Height / 2.0f - Px(7), button.Width - Px(10), Px(14), foreground, true, Gdiplus::StringAlignmentCenter);
}

void SubmitInstall() {
    std::vector<wchar_t> buffer(32768, L'\0');
    GetWindowTextW(g.pathEdit, buffer.data(), static_cast<int>(buffer.size()));
    std::wstring selected;
    std::wstring error;
    if (!NormalizeInstallPath(buffer.data(), selected, error)) {
        g.errorDetail = error;
        InvalidateRect(g.window, nullptr, TRUE);
        MessageBeep(MB_ICONWARNING);
        return;
    }
    g.installPath = std::move(selected);
    g.errorDetail.clear();
    g.progress = 0;
    g.currentAction = Text(L"Starting installation…", L"正在启动安装…");
    SetPage(Page::Installing);
    UpdateWindowTitle();
    // Windows Installer may request elevation after this embedded UI returns.
    // Yield the foreground Z-order so the consent prompt cannot sit behind us.
    SetWindowPos(g.window, HWND_BOTTOM, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    SetEvent(gStartEvent);
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_CREATE: {
        g.window = window;
        gUiWindow.store(window);
        const int dpi = GetDpiForWindow(window);
        g.scale = ScaleForMonitor(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), static_cast<UINT>(dpi));
        g.font = CreateFontW(-Px(14), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");

        g.pathEdit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_TABSTOP | ES_AUTOHSCROLL,
            0, 0, 1, 1, window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kInstallEdit)), gModule, nullptr);
        if (g.pathEdit) {
            SendMessageW(g.pathEdit, WM_SETFONT, reinterpret_cast<WPARAM>(g.font), TRUE);
            SendMessageW(g.pathEdit, EM_SETCUEBANNER, TRUE, reinterpret_cast<LPARAM>(Text(L"Choose a folder — nothing is preselected", L"请选择文件夹（未预填任何路径）").c_str()));
        }
        g.welcomeButton = MakeButton(window, kButtonWelcome, Text(L"Continue", L"继续"));
        g.backButton = MakeButton(window, kButtonBack, Text(L"Back", L"上一步"));
        g.browseButton = MakeButton(window, kButtonBrowse, Text(L"Browse…", L"浏览…"));
        g.installButton = MakeButton(window, kButtonInstall, Text(L"Install", L"安装"));
        g.cancelButton = MakeButton(window, kButtonCancel, Text(L"Cancel", L"取消"));
        g.finishButton = MakeButton(window, kButtonFinish, Text(L"Finish", L"完成"));
        g.launchOption = CreateWindowExW(0, L"BUTTON", Text(L"Open AgentoC when setup finishes", L"安装完成后打开 AgentoC").c_str(),
            WS_CHILD | WS_TABSTOP | BS_AUTOCHECKBOX, 0, 0, 1, 1, window,
            reinterpret_cast<HMENU>(static_cast<INT_PTR>(kButtonLaunchOption)), gModule, nullptr);
        if (g.launchOption) SendMessageW(g.launchOption, BM_SETCHECK, BST_CHECKED, 0);
        for (HWND control : {g.welcomeButton, g.backButton, g.browseButton, g.installButton, g.cancelButton, g.finishButton, g.launchOption}) {
            if (control) SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(g.font), TRUE);
        }

        if (!gResourceDirectory.empty()) {
            const std::filesystem::path logoPath = std::filesystem::path(gResourceDirectory) / L"agentoc-android-logo.png";
            g.logo = Gdiplus::Image::FromFile(logoPath.c_str(), FALSE);
        }
        LayoutControls();
        SetPage(Page::Welcome);
        SetEvent(gUiReadyEvent);
        return 0;
    }
    case WM_SIZE:
        LayoutControls();
        InvalidateRect(window, nullptr, TRUE);
        return 0;
    case WM_DPICHANGED: {
        const RECT* suggested = reinterpret_cast<const RECT*>(lParam);
        ResizeWindowForDpi(window, suggested, HIWORD(wParam));
        LayoutControls();
        InvalidateRect(window, nullptr, TRUE);
        return 0;
    }
    case WM_ERASEBKGND:
        // WM_PAINT renders a complete buffered frame; avoid the white erase
        // between frequent MSI progress updates.
        return 1;
    case kRestoreInstallerWindow:
        SetWindowPos(window, HWND_TOP, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        SetForegroundWindow(window);
        return 0;
    case WM_COMMAND: {
        const UINT id = LOWORD(wParam);
        if (id == kInstallEdit && HIWORD(wParam) == EN_CHANGE) {
            if (!g.errorDetail.empty()) g.errorDetail.clear();
            LayoutControls();
            InvalidateRect(window, nullptr, TRUE);
            return 0;
        }
        if (id == kButtonWelcome) { SetPage(Page::Location); LayoutControls(); UpdateWindowTitle(); return 0; }
        if (id == kButtonBack) { SetPage(Page::Welcome); LayoutControls(); UpdateWindowTitle(); return 0; }
        if (id == kButtonBrowse) { BrowseForFolder(); return 0; }
        if (id == kButtonInstall) { SubmitInstall(); return 0; }
        if (id == kButtonLaunchOption) {
            g.openAfterInstall = SendMessageW(g.launchOption, BM_GETCHECK, 0, 0) == BST_CHECKED;
            return 0;
        }
        if (id == kButtonCancel) {
            gCancelRequested.store(true);
            g.currentAction = Text(L"Cancel requested. Windows Installer is rolling back safely…", L"已请求取消，Windows Installer 正在安全回滚…");
            InvalidateRect(window, nullptr, TRUE);
            return 0;
        }
        if (id == kButtonFinish) {
            g.closing = true;
            SetEvent(gExitEvent);
            DestroyWindow(window);
            return 0;
        }
        return 0;
    }
    case WM_DRAWITEM:
        DrawOwnerButton(reinterpret_cast<const DRAWITEMSTRUCT*>(lParam));
        return TRUE;
    case kInstallMessage: {
        std::unique_ptr<std::wstring> detail;
        if (wParam == 1 || wParam == 3 || wParam == 4) {
            detail.reset(reinterpret_cast<std::wstring*>(lParam));
        }
        if (wParam == 1) {
            if (detail && !detail->empty()) g.currentAction = *detail;
        } else if (wParam == 2) {
            g.progress = std::clamp(static_cast<int>(lParam), 0, 100);
        } else if (wParam == 3) {
            if (detail && !detail->empty()) g.errorDetail = *detail;
        } else if (wParam == 4) {
            g.installSucceeded = gInstallResult.load() == ERROR_SUCCESS;
            if (g.installSucceeded) SetPage(Page::Complete);
            else SetPage(Page::Failed);
            UpdateWindowTitle();
            LayoutControls();
        }
        InvalidateRect(window, nullptr, FALSE);
        return 0;
    }
    case WM_PAINT: {
        PAINTSTRUCT paint{};
        HDC dc = BeginPaint(window, &paint);
        RECT client = ClientRect(window);
        const int width = client.right - client.left;
        const int height = client.bottom - client.top;
        if (width <= 0 || height <= 0) {
            EndPaint(window, &paint);
            return 0;
        }
        Gdiplus::Bitmap frame(width, height, PixelFormat32bppPARGB);
        if (frame.GetLastStatus() == Gdiplus::Ok) {
            Gdiplus::Graphics graphics(&frame);
            graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
            graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
            Gdiplus::SolidBrush background(Color(255, 255, 255));
            graphics.FillRectangle(&background, 0, 0, width, height);
            const float left = Px(274);
            DrawBrandPanel(graphics, client, left);
            DrawMainContent(graphics, client, left);
            Gdiplus::Graphics target(dc);
            target.DrawImage(&frame, 0, 0);
        } else {
            Gdiplus::Graphics graphics(dc);
            graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
            graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
            Gdiplus::SolidBrush background(Color(255, 255, 255));
            graphics.FillRectangle(&background, 0, 0, width, height);
            const float left = Px(274);
            DrawBrandPanel(graphics, client, left);
            DrawMainContent(graphics, client, left);
        }
        EndPaint(window, &paint);
        return 0;
    }
    case WM_CLOSE:
        if (g.page == Page::Installing) {
            gCancelRequested.store(true);
            g.currentAction = Text(L"Cancel requested. Windows Installer is rolling back safely…", L"已请求取消，Windows Installer 正在安全回滚…");
            InvalidateRect(window, nullptr, TRUE);
            return 0;
        }
        if (g.page == Page::Complete || g.page == Page::Failed || g.page == Page::Welcome || g.page == Page::Location) {
            g.closing = true;
            SetEvent(gExitEvent);
            DestroyWindow(window);
            return 0;
        }
        return 0;
    case WM_DESTROY:
        if (!g.closing && !gInstallEnded.load()) SetEvent(gExitEvent);
        if (g.logo) { delete g.logo; g.logo = nullptr; }
        if (g.font) { DeleteObject(g.font); g.font = nullptr; }
        gUiWindow.store(nullptr);
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

unsigned int __stdcall UiThreadMain(void*) {
    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    Gdiplus::GdiplusStartupInput gdiInput;
    Gdiplus::GdiplusStartup(&gGdiPlusToken, &gdiInput, nullptr);
    INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_STANDARD_CLASSES};
    InitCommonControlsEx(&controls);

    WNDCLASSEXW cls{};
    cls.cbSize = sizeof(cls);
    cls.style = CS_HREDRAW | CS_VREDRAW;
    cls.lpfnWndProc = WindowProc;
    cls.hInstance = gModule;
    cls.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    cls.hIcon = LoadIconW(gModule, MAKEINTRESOURCEW(1));
    cls.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    cls.lpszClassName = kWindowClass;
    RegisterClassExW(&cls);

    POINT origin{};
    HMONITOR primary = MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY);
    const UINT systemDpi = GetDpiForSystem();
    g.scale = ScaleForMonitor(primary, systemDpi);
    RECT rect = WindowBoundsForScale(g.scale, systemDpi);
    MONITORINFO monitorInfo{sizeof(monitorInfo)};
    GetMonitorInfoW(primary, &monitorInfo);
    const int windowWidth = rect.right - rect.left;
    const int windowHeight = rect.bottom - rect.top;
    const int left = monitorInfo.rcWork.left + (monitorInfo.rcWork.right - monitorInfo.rcWork.left - windowWidth) / 2;
    const int top = monitorInfo.rcWork.top + (monitorInfo.rcWork.bottom - monitorInfo.rcWork.top - windowHeight) / 2;
    HWND window = CreateWindowExW(0, kWindowClass, kWindowTitle,
        kInstallerWindowStyle, left, top, windowWidth, windowHeight,
        nullptr, nullptr, gModule, nullptr);
    if (window) {
        const DWM_WINDOW_CORNER_PREFERENCE corners = DWMWCP_ROUND;
        DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, &corners, sizeof(corners));
        ShowWindow(window, SW_SHOW);
        UpdateWindow(window);
        SetForegroundWindow(window);
    } else {
        SetEvent(gUiReadyEvent);
        SetEvent(gExitEvent);
    }

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    if (gGdiPlusToken) { Gdiplus::GdiplusShutdown(gGdiPlusToken); gGdiPlusToken = 0; }
    CoUninitialize();
    return 0;
}

void PostUiText(UINT kind, const std::wstring& text) {
    HWND window = gUiWindow.load();
    if (!window) return;
    if (kind == 3) gHasErrorDetail.store(true);
    auto* copy = new (std::nothrow) std::wstring(text);
    if (!copy) return;
    if (!PostMessageW(window, kInstallMessage, kind, reinterpret_cast<LPARAM>(copy))) delete copy;
}

void PostUiProgress(int progress) {
    gProgressValue.store(progress);
    HWND window = gUiWindow.load();
    if (window) PostMessageW(window, kInstallMessage, 2, static_cast<LPARAM>(progress));
}

void ClearEvents() {
    for (HANDLE* event : {&gStartEvent, &gExitEvent, &gUiReadyEvent}) {
        if (*event) { CloseHandle(*event); *event = nullptr; }
    }
}

} // namespace

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        gModule = instance;
        DisableThreadLibraryCalls(instance);
    }
    return TRUE;
}

extern "C" __declspec(dllexport) UINT __stdcall InitializeEmbeddedUI(MSIHANDLE install, LPCWSTR resourcePath, LPDWORD uiLevel) {
    if (!uiLevel) return ERROR_INSTALL_FAILURE;
    if ((*uiLevel & INSTALLUILEVEL_NONE) != 0) return ERROR_SUCCESS;

    g.chinese = PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_CHINESE;
    gResourceDirectory = resourcePath ? resourcePath : L"";
    gCancelRequested.store(false);
    gInstallEnded.store(false);
    gHasErrorDetail.store(false);
    gInstallResult.store(-1);
    gProgressValue.store(0);
    gProgressTicks.store(0);
    gProgressTotal.store(0);
    g.progress = 0;
    g.errorDetail.clear();
    g.installPath.clear();
    g.closing = false;
    ClearEvents();
    gStartEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    gExitEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    gUiReadyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!gStartEvent || !gExitEvent || !gUiReadyEvent) { ClearEvents(); return ERROR_INSTALL_FAILURE; }

    gUiThread = reinterpret_cast<HANDLE>(_beginthreadex(nullptr, 0, UiThreadMain, nullptr, 0, &gUiThreadId));
    if (!gUiThread) { ClearEvents(); return ERROR_INSTALL_FAILURE; }
    HANDLE initializationEvents[] = {gUiReadyEvent, gExitEvent};
    DWORD wait = WaitForMultipleObjects(2, initializationEvents, FALSE, INFINITE);
    if (wait == WAIT_OBJECT_0 + 1) {
        WaitForSingleObject(gUiThread, INFINITE);
        CloseHandle(gUiThread);
        gUiThread = nullptr;
        ClearEvents();
        return ERROR_INSTALL_USEREXIT;
    }
    if (wait != WAIT_OBJECT_0) {
        g.closing = true;
        if (HWND window = gUiWindow.load()) PostMessageW(window, WM_CLOSE, 0, 0);
        WaitForSingleObject(gUiThread, INFINITE);
        CloseHandle(gUiThread);
        gUiThread = nullptr;
        ClearEvents();
        return ERROR_INSTALL_FAILURE;
    }

    HANDLE userActionEvents[] = {gExitEvent, gStartEvent};
    wait = WaitForMultipleObjects(2, userActionEvents, FALSE, INFINITE);
    if (wait == WAIT_OBJECT_0) {
        WaitForSingleObject(gUiThread, INFINITE);
        CloseHandle(gUiThread);
        gUiThread = nullptr;
        ClearEvents();
        return ERROR_INSTALL_USEREXIT;
    }
    if (wait != WAIT_OBJECT_0 + 1) {
        g.closing = true;
        if (HWND window = gUiWindow.load()) PostMessageW(window, WM_CLOSE, 0, 0);
        WaitForSingleObject(gUiThread, INFINITE);
        CloseHandle(gUiThread);
        gUiThread = nullptr;
        ClearEvents();
        return ERROR_INSTALL_FAILURE;
    }

    UINT propertyResult = MsiSetPropertyW(install, L"AGENTOC_INSTALLFOLDER", g.installPath.c_str());
    const UINT launchPropertyResult = MsiSetPropertyW(install, L"AGENTOC_LAUNCH", g.openAfterInstall ? L"1" : L"");
    if (propertyResult == ERROR_SUCCESS && launchPropertyResult != ERROR_SUCCESS) propertyResult = launchPropertyResult;
    if (propertyResult != ERROR_SUCCESS) {
        PostUiText(3, Text(L"Windows Installer could not read the selected installation folder.", L"Windows Installer 无法读取所选安装文件夹。"));
        g.closing = true;
        if (HWND window = gUiWindow.load()) PostMessageW(window, WM_CLOSE, 0, 0);
        WaitForSingleObject(gUiThread, INFINITE);
        CloseHandle(gUiThread);
        gUiThread = nullptr;
        ClearEvents();
        return ERROR_INSTALL_FAILURE;
    }

    *uiLevel = INSTALLUILEVEL_NONE;
    return ERROR_SUCCESS;
}

extern "C" __declspec(dllexport) INT __stdcall EmbeddedUIHandler(UINT messageType, MSIHANDLE record) {
    const INSTALLMESSAGE message = static_cast<INSTALLMESSAGE>(messageType & 0xFF000000);
    if (message == INSTALLMESSAGE_INSTALLSTART) {
        if (HWND window = gUiWindow.load()) PostMessageW(window, kRestoreInstallerWindow, 0, 0);
        PostUiText(1, Text(L"Preparing AgentoC services and application files…", L"正在准备 AgentoC 服务和应用程序文件…"));
        return IDOK;
    }
    if (message == INSTALLMESSAGE_ACTIONSTART) {
        std::wstring action = CopyRecordField(record, 2);
        if (!action.empty()) PostUiText(1, action);
        return IDOK;
    }
    if (message == INSTALLMESSAGE_PROGRESS) {
        const int type = MsiRecordGetInteger(record, 1);
        if (type == 0 || type == 1) {
            gProgressTotal.store(std::max(MsiRecordGetInteger(record, 2), 0));
            gProgressTicks.store(0);
            PostUiProgress(0);
        } else if (type == 2) {
            const int delta = MsiRecordGetInteger(record, 2);
            if (delta > 0) {
                const int ticks = gProgressTicks.fetch_add(delta) + delta;
                const int total = gProgressTotal.load();
                const int percent = total > 0 ? (ticks * 100) / total : gProgressValue.load();
                PostUiProgress(std::clamp(percent, 0, 99));
            }
        }
        if (gCancelRequested.load()) return IDCANCEL;
        return IDOK;
    }
    if (message == INSTALLMESSAGE_ACTIONDATA) {
        if (gCancelRequested.load()) return IDCANCEL;
        return IDOK;
    }
    if (message == INSTALLMESSAGE_ERROR || message == INSTALLMESSAGE_FATALEXIT || message == INSTALLMESSAGE_OUTOFDISKSPACE) {
        std::wstring detail = CopyRecordField(record, 1);
        if (!detail.empty()) PostUiText(3, detail);
        return IDOK;
    }
    if (message == INSTALLMESSAGE_INSTALLEND) {
        if (HWND window = gUiWindow.load()) PostMessageW(window, kRestoreInstallerWindow, 0, 0);
        const int result = MsiRecordGetInteger(record, 3);
        gInstallResult.store(result);
        gInstallEnded.store(true);
        if (result == ERROR_SUCCESS) {
            PostUiProgress(100);
            PostUiText(4, L"");
        } else {
            if (!gHasErrorDetail.load()) {
                const std::wstring code = std::to_wstring(result);
                PostUiText(3, Text(L"Windows Installer error code: ", L"Windows Installer 错误代码：") + code);
            }
            PostUiText(4, L"");
        }
        return IDOK;
    }
    if (message == INSTALLMESSAGE_WARNING || message == INSTALLMESSAGE_INFO || message == INSTALLMESSAGE_ACTIONSTART) return IDOK;
    return 0;
}

extern "C" __declspec(dllexport) UINT __stdcall ShutdownEmbeddedUI() {
    if (gUiThread) {
        HWND window = gUiWindow.load();
        if (!gInstallEnded.load() && window) {
            PostMessageW(window, kRestoreInstallerWindow, 0, 0);
            SetPage(Page::Failed);
            UpdateWindowTitle();
            LayoutControls();
        }
        WaitForSingleObject(gExitEvent, INFINITE);
        if (window) PostMessageW(window, WM_CLOSE, 0, 0);
        WaitForSingleObject(gUiThread, INFINITE);
        CloseHandle(gUiThread);
        gUiThread = nullptr;
    }
    g.window = nullptr;
    gUiWindow.store(nullptr);
    g.pathEdit = nullptr;
    ClearEvents();
    return ERROR_SUCCESS;
}
