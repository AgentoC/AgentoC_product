package com.andysagent.agentoc.core.navigation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.andysagent.agentoc.core.designsystem.AgentocMotion
import com.andysagent.agentoc.core.designsystem.AgentocSizes
import com.andysagent.agentoc.core.designsystem.AgentocSpacing
import com.andysagent.agentoc.core.designsystem.AgentoShapes
import com.andysagent.agentoc.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.agentoc.core.designsystem.AgentoGlassSurface
import com.andysagent.agentoc.core.designsystem.AgentoGlassMaterial
import com.andysagent.agentoc.core.designsystem.recordToLayer
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.core.designsystem.LocalAgentoPageBackdropOrigin
import com.andysagent.agentoc.core.designsystem.LocalMotionPolicy
import com.andysagent.agentoc.core.designsystem.MotionPreference
import com.andysagent.agentoc.core.designsystem.agentoComposerShadow
import com.andysagent.agentoc.core.designsystem.agentoPressScale
import com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens

enum class ProjectNavLevel {
    L1_Projects,
    L2_Sessions,
}

enum class AgentoDestination(val labelRes: Int, val icon: AgentoWebGlyph) {
    // Routes remain stable for existing navigation and deep links. Home is the
    // notification-driven starting surface; device management belongs in
    // Settings and must not displace it.
    Sessions(R.string.navigation_chat, AgentoWebGlyph.ChatBubble),
    Home(R.string.navigation_home, AgentoWebGlyph.Home),
    Settings(R.string.navigation_settings, AgentoWebGlyph.Settings),

    ;

    val route: String get() = name.lowercase()

    companion object {
        fun fromRoute(route: String?): AgentoDestination = entries.firstOrNull { it.route == route } ?: Sessions
    }
}

enum class AgentoWindowSizeClass { Compact, Medium, Expanded }

private val PrimaryDestinations = listOf(
    AgentoDestination.Sessions,
    AgentoDestination.Home,
    AgentoDestination.Settings,
)

/**
 * Chat, Home and Settings are peer destinations. The dock lens communicates
 * location. Pages exchange side by side on one horizontal axis, not through
 * detail parallax or independently timed crossfades. Equal opposite offsets
 * keep the viewport covered without stacking two sets of readable text.
 */
internal fun primaryNavigationUsesPeerTransition(
    initial: AgentoDestination,
    target: AgentoDestination,
): Boolean = initial != target

private fun primaryPeerRank(destination: AgentoDestination): Int =
    PrimaryDestinations.indexOf(destination).coerceAtLeast(0)

internal fun primaryPeerIsForward(
    initial: AgentoDestination,
    target: AgentoDestination,
): Boolean = primaryPeerRank(target) >= primaryPeerRank(initial)

internal fun primaryPeerEnterTransition(preference: MotionPreference): EnterTransition = when (preference) {
    MotionPreference.None -> EnterTransition.None
    MotionPreference.Reduced -> fadeIn(tween(120))
    MotionPreference.Full -> EnterTransition.None
}

internal fun primaryPeerExitTransition(preference: MotionPreference): ExitTransition = when (preference) {
    MotionPreference.None -> ExitTransition.None
    MotionPreference.Reduced -> fadeOut(tween(120))
    MotionPreference.Full -> ExitTransition.None
}

private class PrimaryPeerDirection { var forward by mutableStateOf(true) }

/**
 * The NavHost has no current route during its first composition. Use the UDF
 * selection for that frame instead of [AgentoDestination.fromRoute]'s legacy
 * Sessions fallback, otherwise the dock briefly renders Chat before Home is
 * installed as the start destination.
 */
internal fun visibleNavigationDestination(
    currentRoute: String?,
    selected: AgentoDestination,
): AgentoDestination = currentRoute?.let(AgentoDestination::fromRoute) ?: selected

@Composable
fun AgentoAdaptiveScaffold(
    selected: AgentoDestination,
    onDestinationSelected: (AgentoDestination) -> Unit,
    onCreateProject: (() -> Unit)? = null,
    onCreateSession: (() -> Unit)? = null,
    windowSizeClass: AgentoWindowSizeClass = AgentoWindowSizeClass.Compact,
    dockVisible: Boolean = true,
    modifier: Modifier = Modifier,
    projectActionProgress: State<Float>? = null,
    content: @Composable (Modifier, AgentoDestination, String, Boolean) -> Unit,
) {
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val backStackDestination = visibleNavigationDestination(currentRoute, selected)
    val initialRoute = remember { selected.route }
    val motionPolicy = LocalMotionPolicy.current
    val spatialSign = if (LocalLayoutDirection.current == LayoutDirection.Ltr) 1f else -1f
    val colors = LocalAgentocColors.current
    // The navigation bar is the only control that samples the page beneath it.
    // Keeping the capture inside the NavHost layer prevents it from recording
    // transient overlays during route transitions.
    val navigationBackdrop = rememberGraphicsLayer()
    val dockGeometry = remember { PrimaryDockGeometry() }
    val peerClockStore = remember { NavigationPeerClockStore() }
    val peerDirection = remember { PrimaryPeerDirection() }
    var acknowledgedSelection by remember { mutableStateOf(selected) }
    val pendingSelection = selected.takeIf { it != acknowledgedSelection }
    if (selected == backStackDestination) {
        SideEffect { acknowledgedSelection = selected }
    }

    fun navigateTo(destination: AgentoDestination) {
        // Keep the state machine and the visual navigation stack in sync for
        // both nav-item taps and links emitted by a destination surface.
        onDestinationSelected(destination)
        val currentVisit = navController.currentBackStackEntry
        if (currentVisit?.destination?.route == destination.route) return
        val enteringVisit = peerClockStore.clock
        val outgoingVisitVisible = navController.visibleEntries.value.any {
            it.id != currentVisit?.id && it.destination.route == destination.route
        }
        if (enteringVisit != null && outgoingVisitVisible &&
            enteringVisit?.visitId == currentVisit?.id && !enteringVisit.settled()
        ) {
            // Returning to the still-visible outgoing tab cancels this unfinished
            // visit. Reuse its actual NavHost object/position instead of pushing a
            // second copy from the edge, which also gives the dock a wrong clock.
            navController.popBackStack(destination.route, inclusive = false)
            return
        }
        // A tab tap is a new visit, not Back. Popping to an older copy of
        // Home discards the page that opened it (Home -> Settings -> Home).
        // Preserve completed visit history; only the unfinished reversal above
        // or the system Back action consumes it.
        navController.navigate(destination.route) {
            launchSingleTop = true
            restoreState = true
        }
    }

    // A surface can request a destination directly (for example Home ->
    // Projects). Reconcile state changes into the navigation stack. Keep this
    // effect keyed only by the requested destination so a system-back pop is
    // not immediately pushed forward again by stale selected state.
    LaunchedEffect(selected) {
        if (currentRoute != null && currentRoute != selected.route) {
            navigateTo(selected)
        }
    }

    // NavHost owns the actual back-stack pop. Reflect that pop back into the
    // UDF state instead of letting the next selected-state reconciliation
    // reopen the destination the user just left.
    LaunchedEffect(currentRoute) {
        if (currentRoute != null && currentRoute != selected.route) {
            onDestinationSelected(backStackDestination)
        }
    }

    val isDark = colors.canvas.red < 0.5f
    // Keep the root edge-to-edge. The navigation is an overlay, so destination
    // surfaces can paint and scroll all the way to the bottom behind the dock
    // instead of receiving Scaffold's reserved bottom-bar inset.
    Layout(
        modifier = modifier
            .fillMaxSize()
            .background(
                brush = if (isDark) AgentoFrostedTokens.AtmosphericCanvasDark else AgentoFrostedTokens.AtmosphericCanvasLight,
            ),
        content = {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .testTag("primary-reading-plane")
                .primaryReadingPlane(navigationBackdrop, dockGeometry),
        ) {
            NavHost(
                navController = navController,
                startDestination = initialRoute,
                modifier = Modifier.fillMaxSize(),
                // The destination pages are peers, not successive detail levels.
                // The persistent dock lens handles spatial orientation; content
                // exchanges as adjacent planes. No parallax, edge shadow or
                // dimming: those depth cues belong to a detail push, not tabs.
                enterTransition = {
                    val forward = primaryPeerIsForward(
                        initial = AgentoDestination.fromRoute(initialState.destination.route),
                        target = AgentoDestination.fromRoute(targetState.destination.route),
                    )
                    peerDirection.forward = forward
                    if (
                        motionPolicy.preference == MotionPreference.None ||
                        !primaryNavigationUsesPeerTransition(
                            initial = AgentoDestination.fromRoute(initialState.destination.route),
                            target = AgentoDestination.fromRoute(targetState.destination.route),
                        )
                    ) {
                        EnterTransition.None
                    } else {
                        primaryPeerEnterTransition(motionPolicy.preference)
                    }
                },
                exitTransition = {
                    val forward = primaryPeerIsForward(
                        initial = AgentoDestination.fromRoute(initialState.destination.route),
                        target = AgentoDestination.fromRoute(targetState.destination.route),
                    )
                    peerDirection.forward = forward
                    if (
                        motionPolicy.preference == MotionPreference.None ||
                        !primaryNavigationUsesPeerTransition(
                            initial = AgentoDestination.fromRoute(initialState.destination.route),
                            target = AgentoDestination.fromRoute(targetState.destination.route),
                        )
                    ) {
                        ExitTransition.None
                    } else {
                        primaryPeerExitTransition(motionPolicy.preference)
                    }
                },
                popEnterTransition = {
                    val forward = primaryPeerIsForward(
                        initial = AgentoDestination.fromRoute(initialState.destination.route),
                        target = AgentoDestination.fromRoute(targetState.destination.route),
                    )
                    peerDirection.forward = forward
                    if (
                        motionPolicy.preference == MotionPreference.None ||
                        !primaryNavigationUsesPeerTransition(
                            initial = AgentoDestination.fromRoute(initialState.destination.route),
                            target = AgentoDestination.fromRoute(targetState.destination.route),
                        )
                    ) {
                        EnterTransition.None
                    } else {
                        primaryPeerEnterTransition(motionPolicy.preference)
                    }
                },
                popExitTransition = {
                    val forward = primaryPeerIsForward(
                        initial = AgentoDestination.fromRoute(initialState.destination.route),
                        target = AgentoDestination.fromRoute(targetState.destination.route),
                    )
                    peerDirection.forward = forward
                    if (
                        motionPolicy.preference == MotionPreference.None ||
                        !primaryNavigationUsesPeerTransition(
                            initial = AgentoDestination.fromRoute(initialState.destination.route),
                            target = AgentoDestination.fromRoute(targetState.destination.route),
                        )
                    ) {
                        ExitTransition.None
                    } else {
                        primaryPeerExitTransition(motionPolicy.preference)
                    }
                },
            ) {
                AgentoDestination.entries.forEach { destination ->
                    composable(destination.route) { visit ->
                        // This child belongs to NavHost's actual transition.
                        // Its phase and the slide have the same curve and clock;
                        // the dock reads this State directly in measure/draw.
                        val pageTransition = transition
                        val fadePhase = pageTransition.animateFloat(
                            transitionSpec = { when (motionPolicy.preference) {
                                MotionPreference.None -> snap()
                                MotionPreference.Reduced -> tween(120)
                                MotionPreference.Full -> tween(380, easing = FastOutSlowInEasing)
                            } }, label = "primary_peer_phase",
                        ) { if (it == EnterExitState.Visible) 1f else 0f }
                        // Translation belongs to the page layer. A layout slide
                        // schedules measure/placement throughout the exchange;
                        // the destination's endpoint layout stays fixed here.
                        // Animate the actual offset so a third tab can retarget
                        // from the current position without changing its sign.
                        val offset = pageTransition.animateFloat(
                            transitionSpec = { when (motionPolicy.preference) {
                                MotionPreference.Full -> tween(380, easing = FastOutSlowInEasing)
                                else -> snap()
                            } }, label = "primary_peer_layer_offset",
                        ) { stage ->
                            if (motionPolicy.preference != MotionPreference.Full) 0f else when (stage) {
                                EnterExitState.PreEnter -> if (peerDirection.forward) 1f else -1f
                                EnterExitState.Visible -> 0f
                                EnterExitState.PostExit -> if (peerDirection.forward) -1f else 1f
                            }
                        }
                        val phase = remember(offset, fadePhase, motionPolicy.preference) {
                            derivedStateOf {
                                if (motionPolicy.preference == MotionPreference.Full)
                                    (1f - kotlin.math.abs(offset.value)).coerceIn(0f, 1f)
                                else fadePhase.value
                            }
                        }
                        val peerClock = remember(visit.id, pageTransition, phase) {
                            NavigationPeerClock(visit.id, destination, phase,
                                entering = { pageTransition.targetState == EnterExitState.Visible },
                                settled = { pageTransition.currentState == EnterExitState.Visible &&
                                    pageTransition.targetState == EnterExitState.Visible && !pageTransition.isRunning })
                        }
                        DisposableEffect(peerClock) { onDispose { peerClock.disposed = true } }
                        // Interrupted child transitions can temporarily both
                        // report Visible. Only the actual back-stack target may
                        // publish the dock clock; composition order is not ownership.
                        if (visit.id == backStackEntry?.id) {
                            SideEffect { peerClockStore.clock = peerClock }
                        }
                        // The dock's slots use logical placement. Mirror only
                        // the physical translation, keeping its shared phase.
                        Box(Modifier.fillMaxSize().graphicsLayer { translationX = spatialSign * size.width * offset.value }
                            .clipToBounds().testTag("primary-page-${destination.route}")) {
                            content(Modifier.fillMaxSize(), destination, visit.id, backStackEntry?.id == visit.id)
                        }
                    }
                }
            }
        }

        // Navigation is a single floating control layer. Creation belongs to
        // its relevant page, so the dock never competes with an empty state
        // or appears as an unexplained fourth primary action.
        AnimatedVisibility(
            visible = dockVisible,
            enter = fadeIn(AgentocMotion.Spatial) + slideInVertically(
                initialOffsetY = { it / 3 },
                animationSpec = AgentocMotion.SpatialOffset,
            ),
            exit = fadeOut(AgentocMotion.Spatial) + slideOutVertically(
                targetOffsetY = { it / 3 },
                animationSpec = AgentocMotion.SpatialOffset,
            ),
        ) {
            CompositionLocalProvider(LocalNavigationPeerClockStore provides peerClockStore) {
                AgentoBottomNavigation(
                    modifier = Modifier
                        .widthIn(max = 520.dp)
                        .padding(horizontal = AgentocSpacing.Gutter)
                        .navigationBarsPadding()
                        .padding(bottom = 10.dp),
                    selected = backStackDestination,
                    pendingSelection = pendingSelection,
                    onDestinationSelected = ::navigateTo,
                    onCreateProject = onCreateProject,
                    onCreateSession = onCreateSession,
                    projectActionProgress = projectActionProgress,
                    backdropLayer = navigationBackdrop,
                )
            }
        }
        },
    ) { measurables, constraints ->
        // Measure the retained dock first. Content uses full page geometry and
        // keeps its list identity/padding; only its reader-facing pixels exit.
        val dock = measurables.getOrNull(1)?.measure(constraints.copy(minWidth = 0, minHeight = 0))
        dockGeometry.measure(dock?.height ?: 0)
        val page = measurables[0].measure(constraints)
        layout(constraints.maxWidth, constraints.maxHeight) {
            page.place(0, 0)
            dock?.place((constraints.maxWidth - dock.width) / 2, constraints.maxHeight - dock.height)
        }
    }
}

/**
 * A quiet foreground dock. Labels are retained only when every destination
 * fits comfortably; larger type or constrained space uses icons with full
 * accessibility names instead of truncated labels. The selection is a clear glass
 * lens, not a filled navigation chip: active color belongs to the glyph and
 * label, while the material simply separates controls from page content.
 */
@Composable
fun AgentoBottomNavigation(
    selected: AgentoDestination,
    onDestinationSelected: (AgentoDestination) -> Unit,
    onCreateProject: (() -> Unit)? = null,
    onCreateSession: (() -> Unit)? = null,
    backdropLayer: GraphicsLayer? = null,
    modifier: Modifier = Modifier,
    projectActionProgress: State<Float>? = null,
    pendingSelection: AgentoDestination? = null,
) {
    val policy = LocalMotionPolicy.current
    val density = LocalDensity.current
    val largeType = density.fontScale >= 1.6f
    val dockHeight = if (largeType) AgentocSizes.BottomNavigation
        else maxOf(AgentocSizes.BottomNavigation, (30f + 16f * density.fontScale).dp)
    val selectionHeight = dockHeight - 8.dp
    val labels = PrimaryDestinations.map { stringResource(it.labelRes) }
    val labelStyle = androidx.compose.material3.MaterialTheme.typography.labelSmall
        .copy(fontWeight = FontWeight.SemiBold)
    val textMeasurer = rememberTextMeasurer()
    // Measure the widest selected-state label, not only the current selection.
    // Changing tabs must not unexpectedly bring clipped text back into the dock.
    val labelSizes = remember(labels, labelStyle, textMeasurer, density) {
        labels.map { textMeasurer.measure(it, labelStyle, softWrap = false, maxLines = 1).size }
    }
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    val navigationOffset = remember { mutableStateOf(IntOffset.Zero) }
    val pageBackdropOrigin = LocalAgentoPageBackdropOrigin.current
    // Chat keeps the wide dock because it can carry its contextual creation
    // action. On the other primary pages the dock contracts to the exact
    // resting composer silhouette, rather than reading as a full-width bar.
    val peerStore = LocalNavigationPeerClockStore.current
    val peerClock = peerStore?.clock?.takeIf { it.entering() }
    // A direct UDF request can precede NavHost's new child by a frame. Keep
    // following the visible entering page until the actual child handoff.
    // A native/predictive Back with no UDF request still follows its actual child.
    val visualDestination = pendingSelection ?: peerClock?.destination ?: selected
    val contextualAction = when {
        visualDestination != AgentoDestination.Sessions -> null
        onCreateSession != null -> NavigationDockAction(
            label = stringResource(R.string.navigation_new_session),
            glyph = AgentoWebGlyph.Chat,
            onClick = onCreateSession,
        )
        onCreateProject != null -> NavigationDockAction(
            label = stringResource(R.string.navigation_new_project),
            glyph = AgentoWebGlyph.FolderPlus,
            onClick = onCreateProject,
        )
        else -> null
    }
    val dockTarget = NavigationDockTarget(visualDestination, contextualAction != null)
    val dockMotion = remember { NavigationDockMotion(dockTarget) }
    if (peerStore == null) {
        LaunchedEffect(dockTarget, policy.preference) { dockMotion.retarget(dockTarget, policy.preference) }
    }
    val dockFrame = {
        // The child registers its real clock after composition. Consume it in
        // this frame's layout/draw rather than waiting for another composition
        // and SideEffect. A later requested tab must not suppress the currently
        // visible page's clock while NavHost is still handing the visit over.
        peerStore?.clock?.let { actualClock ->
            dockMotion.follow(NavigationDockTarget(actualClock.destination,
                actualClock.destination == AgentoDestination.Sessions &&
                    (onCreateSession != null || onCreateProject != null)), actualClock)
        }
        dockMotion.frame(dockTarget)
    }
    // Keep the outgoing pixels until the exit completes, but remove its touch
    // and accessibility action immediately when leaving Chat.
    var retainedAction by remember { mutableStateOf(contextualAction) }
    SideEffect { if (contextualAction != null) retainedAction = contextualAction }
    val actionStillVisible by remember(dockTarget) { derivedStateOf { dockFrame().actionPresence > 0f } }

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .height(dockHeight),
        contentAlignment = Alignment.Center,
    ) {
        // Decide label visibility from the narrowest resting geometry, so
        // icon/label layout doesn't switch halfway through the morph.
        val minimumSlotWidth = minOf(
            maxWidth * AgentocSizes.CollapsedComposerWidthFraction,
            maxWidth -
                if (onCreateSession != null || onCreateProject != null) AgentocSizes.BottomNavigation + 10.dp else 0.dp,
        ) / PrimaryDestinations.size
        val showLabels = !largeType && with(density) {
            labelSizes.all { size ->
                size.width.toDp() <= minimumSlotWidth - 16.dp &&
                    size.height.toDp() + 22.dp <= selectionHeight - 8.dp
            }
        }
        // The shell and action share continuously allocated space; no fixed
        // AnimatedVisibility slot suddenly appears or disappears.
        // Read the continuous state only during measure/placement. The outer
        // constraint scope and label decisions remain stable throughout a morph.
        Layout(content = {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(dockHeight)
                .testTag("bottom-navigation-shell")
                .agentoComposerShadow(shape = AgentoShapes.PillShape),
            contentAlignment = Alignment.Center,
        ) {
            AgentoFrostedGlassBox(
                modifier = Modifier
                    .fillMaxSize()
                    .onGloballyPositioned { coordinates ->
                        val position = coordinates.positionInRoot()
                        navigationOffset.value = IntOffset(
                            pageBackdropOrigin.x - position.x.roundToInt(),
                            pageBackdropOrigin.y - position.y.roundToInt(),
                        )
                },
                shape = AgentoShapes.PillShape,
                surface = AgentoGlassSurface.Neutral,
                // Match the chat composer and notification substrate. Passing
                // the Dock brush would paint an extra 35% white layer over the
                // sampled blur and turn this into a milky opaque bar.
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                showTopHairline = true,
                specularBrush = if (isDark) {
                    AgentoFrostedTokens.SpecularBorderDark
                } else {
                    AgentoFrostedTokens.SpecularBorderLight
                },
                backdropLayer = backdropLayer,
                backdropOffsetProvider = { navigationOffset.value },
                material = AgentoGlassMaterial.LiquidClear,
                hasShadow = false,
            ) {
                // Equal-width thirds keep every tab an identical touch
                // target on the full-width dock. One refractive lens stays
                // mounted and slides between the slots.
                // The lens has a 4dp vertical clearance inside the 56dp
                // dock. Mirror that clearance horizontally so the first and
                // last selected states never visually touch the pill edge.
                val lensEdgeInset =
                    (dockHeight - selectionHeight) / 2
                Layout(modifier = Modifier.fillMaxSize(), content = {
                AgentoFrostedGlassBox(
                    modifier = Modifier
                        .height(selectionHeight)
                        .testTag("bottom-navigation-selection"),
                    shape = AgentoShapes.PillShape,
                    surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkLensGlassBrush else AgentoFrostedTokens.LightLensGlassBrush, keepWithoutBackdrop = true),
                    blurRadius = 0.dp,
                    backdropLayer = null,
                    backdropOffset = IntOffset.Zero,
                    material = AgentoGlassMaterial.LiquidClear,
                    showTopHairline = true,
                    hasShadow = true,
                    shadowElevation = 3.dp,
                    shadowAlpha = if (isDark) 0.08f else 0.04f,
                    shadowSpotAlpha = if (isDark) 0.04f else 0.015f,
                ) {}

                Row(
                    modifier = Modifier.fillMaxSize(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PrimaryDestinations.forEach { destination ->
                        NavigationDockTab(
                            destination = destination,
                            isSelected = visualDestination == destination,
                            showLabels = showLabels,
                            height = selectionHeight,
                            emphasis = { dockFrame().emphasis[destination.ordinal] },
                            onClick = { onDestinationSelected(destination) },
                        )
                    }
                }
                }) { measurables, constraints ->
                    val slotWidth = constraints.maxWidth.toFloat() / PrimaryDestinations.size
                    val inset = lensEdgeInset.roundToPx()
                    val lens = measurables[0].measure(Constraints.fixed(
                        (slotWidth - inset * 2).roundToInt().coerceAtLeast(0),
                        selectionHeight.roundToPx(),
                    ))
                    val tabs = measurables[1].measure(Constraints.fixed(constraints.maxWidth, constraints.maxHeight))
                    layout(constraints.maxWidth, constraints.maxHeight) {
                        lens.placeRelative((slotWidth * dockFrame().lensSlot.coerceIn(0f, 2f)).roundToInt() + inset, inset)
                        tabs.placeRelative(0, 0)
                    }
                }
            }
        }
        (contextualAction ?: retainedAction?.takeIf { actionStillVisible })?.let { action ->
            ContextualDockAction(
                label = action.label,
                glyph = action.glyph,
                onClick = action.onClick,
                enabled = contextualAction != null && dockMotion.settled(dockTarget),
                projectProgress = projectActionProgress,
                sessionRole = onCreateSession != null,
                backdropLayer = backdropLayer,
                presence = { dockFrame().actionPresence },
            )
        }
        }) { measurables, constraints ->
            val frame = dockFrame()
            dockMotion.presented(frame)
            val width = (constraints.maxWidth * frame.widthFraction.coerceIn(
                AgentocSizes.CollapsedComposerWidthFraction, 1f,
            )).roundToInt()
            val actionExtent = ((AgentocSizes.BottomNavigation + 10.dp).toPx() *
                frame.actionPresence).roundToInt()
            val shell = measurables[0].measure(Constraints.fixed((width - actionExtent).coerceAtLeast(0), constraints.maxHeight))
            val action = measurables.getOrNull(1)?.measure(Constraints.fixed(
                AgentocSizes.BottomNavigation.roundToPx(), AgentocSizes.BottomNavigation.roundToPx(),
            ))
            layout(width, constraints.maxHeight) {
                shell.placeRelative(actionExtent, 0)
                action?.placeRelative(0, (constraints.maxHeight - action.height) / 2)
            }
        }
    }
}

/** Foreground tint reads the same displayed phase in draw, not a later recomposition. */
@Composable
private fun RowScope.NavigationDockTab(
    destination: AgentoDestination,
    isSelected: Boolean,
    showLabels: Boolean,
    height: androidx.compose.ui.unit.Dp,
    emphasis: () -> Float,
    onClick: () -> Unit,
) {
    val colors = LocalAgentocColors.current
    val inactiveColor = if (colors.canvas.red < .5f) Color(0x99EBEBF5) else Color(0x993C3C43)
    val label = stringResource(destination.labelRes)
    val interactionSource = remember { MutableInteractionSource() }
    val foregroundPaint = remember { Paint() }
    Box(
        modifier = Modifier.weight(1f).height(height)
            .clickable(interactionSource = interactionSource, indication = null, role = Role.Tab, onClick = onClick)
            .agentoPressScale(pressedScale = .94f, interactionSource = interactionSource, hapticFeedback = false)
            .semantics { selected = isSelected; contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 4.dp)
                .testTag("bottom-navigation-foreground-${destination.route}")
                .drawWithContent {
                    // Only the glyph/text alpha mask enters this small layer;
                    // the glass substrate and selection lens are never tinted.
                    foregroundPaint.colorFilter = ColorFilter.tint(
                        lerp(inactiveColor, colors.accentPrimary, emphasis()))
                    val canvas = drawContext.canvas
                    canvas.saveLayer(Rect(Offset.Zero, size), foregroundPaint)
                    drawContent()
                    canvas.restore()
                },
            verticalArrangement = Arrangement.spacedBy(2.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            AgentoWebIcon(destination.icon, contentDescription = null,
                modifier = Modifier.size(if (showLabels) 20.dp else 24.dp), tint = Color.Black)
            if (showLabels) Text(
                text = label,
                style = androidx.compose.material3.MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis, color = Color.Black,
            )
        }
    }
}

private data class NavigationDockAction(
    val label: String,
    val glyph: AgentoWebGlyph,
    val onClick: () -> Unit,
)

/** A sequential glyph dissolve, not two opaque symbols over one another. */
internal fun projectDockGlyphAlpha(progress: Float, session: Boolean): Float {
    val p = progress.coerceIn(0f, 1f)
    return if (session) ((p - 0.45f) / 0.55f).coerceIn(0f, 1f)
        else ((0.55f - p) / 0.55f).coerceIn(0f, 1f)
}

@Composable
private fun ContextualDockAction(
    label: String,
    glyph: AgentoWebGlyph,
    onClick: () -> Unit,
    backdropLayer: GraphicsLayer?,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    projectProgress: State<Float>? = null,
    sessionRole: Boolean = false,
    presence: () -> Float = { 1f },
) {
    val colors = LocalAgentocColors.current
    val actionOffset = remember { mutableStateOf(IntOffset.Zero) }
    val pageBackdropOrigin = LocalAgentoPageBackdropOrigin.current
    val roleReady = projectProgress == null ||
        if (sessionRole) projectProgress.value >= 0.999f else projectProgress.value <= 0.001f
    val interactive = enabled && roleReady
    // The full touch slot stays put. Only the visible disc grows with the dock;
    // its glyph and diffuse shadow are not raster-scaled into a tiny dot.
    Layout(
        modifier = modifier
            .size(AgentocSizes.BottomNavigation)
            .testTag("bottom-navigation-contextual-action")
            .agentoPressScale(pressedScale = 0.94f, onClick = if (interactive) onClick else null)
            .then(if (interactive) Modifier.semantics { contentDescription = label }
                else Modifier.clearAndSetSemantics {}),
        content = {
            AgentoFrostedGlassBox(
                modifier = Modifier
                    .testTag("bottom-navigation-action-surface")
                    .agentoComposerShadow(shape = CircleShape)
                    .onGloballyPositioned { coordinates ->
                        val position = coordinates.positionInRoot()
                        actionOffset.value = IntOffset(
                            pageBackdropOrigin.x - position.x.roundToInt(),
                            pageBackdropOrigin.y - position.y.roundToInt(),
                        )
                    },
                shape = CircleShape,
                surface = AgentoGlassSurface.Neutral,
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                backdropLayer = backdropLayer,
                backdropOffsetProvider = { actionOffset.value },
                material = AgentoGlassMaterial.LiquidClear,
                hasShadow = false,
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier.graphicsLayer { alpha = navigationActionFrame(presence()).glyphAlpha }
                        .testTag("bottom-navigation-action-glyph"),
                    contentAlignment = Alignment.Center,
                ) {
                    if (projectProgress != null) {
                        listOf(false, true).forEach { session ->
                            AgentoWebIcon(
                                glyph = if (session) AgentoWebGlyph.Chat else AgentoWebGlyph.FolderPlus,
                                contentDescription = null,
                                modifier = Modifier.size(20.dp).graphicsLayer {
                                    val alphaProgress = projectDockGlyphAlpha(projectProgress.value, session)
                                    alpha = alphaProgress
                                    scaleX = 0.88f + 0.12f * alphaProgress
                                    scaleY = scaleX
                                },
                                tint = colors.textPrimary,
                            )
                        }
                    } else AgentoWebIcon(
                        glyph = glyph,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                        tint = colors.textPrimary,
                    )
                }
            }
        },
    ) { measurables, constraints ->
        val frame = navigationActionFrame(presence())
        val diameter = frame.diameter.dp.roundToPx().coerceIn(0, minOf(constraints.maxWidth, constraints.maxHeight))
        val disc = measurables.single().measure(Constraints.fixed(diameter, diameter))
        layout(constraints.maxWidth, constraints.maxHeight) {
            disc.placeRelative(frame.start.dp.roundToPx(), (constraints.maxHeight - diameter) / 2)
        }
    }
}
