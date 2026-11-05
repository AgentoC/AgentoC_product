package com.andysagent.agentoc.core.navigation

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin

/** A local indentation, in physical coordinates; the opposite edge stays almost still. */
internal fun navigationContactPath(size: Size, contact: Offset, strength: Float, depth: Float): Path {
    val radius = minOf(size.width, size.height) / 2f
    if (radius <= 0f) return Path()
    val straight = (size.width - radius * 2f).coerceAtLeast(0f)
    val perimeter = 2f * straight + 2f * PI.toFloat() * radius
    val touch = Offset(contact.x.coerceIn(0f, 1f) * size.width, contact.y.coerceIn(0f, 1f) * size.height)
    val spread = size.height * .62f
    val points = List(80) { index ->
        val distance = perimeter * index / 80f
        val p: Offset
        val normal: Offset
        when {
            distance < straight -> {
                p = Offset(radius + distance, 0f); normal = Offset(0f, -1f)
            }
            distance < straight + PI.toFloat() * radius -> {
                val angle = (distance - straight) / radius - PI.toFloat() / 2f
                normal = Offset(cos(angle), sin(angle))
                p = Offset(size.width - radius, radius) + normal * radius
            }
            distance < 2f * straight + PI.toFloat() * radius -> {
                p = Offset(size.width - radius - (distance - straight - PI.toFloat() * radius), size.height)
                normal = Offset(0f, 1f)
            }
            else -> {
                val angle = (distance - 2f * straight - PI.toFloat() * radius) / radius + PI.toFloat() / 2f
                normal = Offset(cos(angle), sin(angle))
                p = Offset(radius, radius) + normal * radius
            }
        }
        val delta = p - touch
        val influence = exp(-(delta.x * delta.x + delta.y * delta.y) / (2f * spread * spread))
        p - normal * (depth.coerceAtMost(radius * .2f) * strength.coerceIn(0f, 1f) * influence)
    }
    // Smooth the sampled contour; no corners appear where the contact travels.
    return Path().apply {
        moveTo(points[0].x, points[0].y)
        points.indices.forEach { i ->
            val previous = points[(i + points.size - 1) % points.size]
            val start = points[i]
            val end = points[(i + 1) % points.size]
            val next = points[(i + 2) % points.size]
            val first = start + (end - previous) / 6f
            val second = end - (next - start) / 6f
            cubicTo(first.x, first.y, second.x, second.y, end.x, end.y)
        }
        close()
    }
}
