package com.andysagent.agentoc.feature.workbench

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.andysagent.agentoc.core.agentui.AgentMarkdown
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

private data class PdfPreviewPage(val image: Bitmap, val count: Int)

@Composable
internal fun ChangedFilePreview(path: String, state: WebParityUiState, onDismiss: () -> Unit) {
    val colors = LocalAgentocColors.current
    val payload = state.filePayload?.takeIf { state.selectedFile == path }
    val context = LocalContext.current
    var pageIndex by remember(path) { mutableIntStateOf(0) }
    val pdfPage by produceState<Result<PdfPreviewPage>?>(null, payload, pageIndex) {
        value = null
        if (payload?.mimeType?.startsWith("application/pdf", ignoreCase = true) != true) return@produceState
        value = withContext(Dispatchers.IO) {
            runCatching {
                val file = File.createTempFile("agentoc-preview-", ".pdf", context.cacheDir)
                try {
                    file.writeBytes(payload.bytes)
                    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                        PdfRenderer(descriptor).use { renderer ->
                            require(renderer.pageCount > 0 && pageIndex in 0 until renderer.pageCount)
                            renderer.openPage(pageIndex).use { page ->
                                val width = minOf(1200, page.width * 2).coerceAtLeast(1)
                                val height = (page.height.toLong() * width / page.width.coerceAtLeast(1)).coerceIn(1, 2400).toInt()
                                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                                bitmap.eraseColor(AndroidColor.WHITE)
                                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                                PdfPreviewPage(bitmap, renderer.pageCount)
                            }
                        }
                    }
                } finally { file.delete() }
            }
        }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxWidth(0.94f).fillMaxHeight(0.9f).background(colors.canvas).padding(16.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(path.substringAfterLast('/').substringAfterLast('\\'), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.changed_file_close)) }
            }
            when {
                state.selectedFile != path || state.fileReadInProgress -> Text(stringResource(R.string.changed_file_loading))
                payload == null -> Text(stringResource(R.string.changed_file_unavailable))
                payload.mimeType.startsWith("text/", ignoreCase = true) -> Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
                    AgentMarkdown(payload.bytes.toString(Charsets.UTF_8))
                }
                payload.mimeType.startsWith("application/pdf", ignoreCase = true) -> {
                    val result = pdfPage
                    val page = result?.getOrNull()
                    if (page != null) {
                        Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
                            Image(page.image.asImageBitmap(), contentDescription = stringResource(R.string.changed_file_pdf_page, pageIndex + 1, page.count), modifier = Modifier.fillMaxWidth())
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = { pageIndex-- }, enabled = pageIndex > 0) { Text(stringResource(R.string.changed_file_previous)) }
                            Text(stringResource(R.string.changed_file_pdf_page, pageIndex + 1, page.count))
                            TextButton(onClick = { pageIndex++ }, enabled = pageIndex + 1 < page.count) { Text(stringResource(R.string.changed_file_next)) }
                        }
                    } else Text(stringResource(if (result == null) R.string.changed_file_loading else R.string.changed_file_unavailable))
                }
                else -> Text(stringResource(R.string.changed_file_unavailable))
            }
        }
    }
}
