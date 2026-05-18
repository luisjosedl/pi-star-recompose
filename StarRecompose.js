/******************************************************************************
 * AstroDL - Star Recompose  v1.1
 * Part of the AstroDL Suite for PixInsight.
 * by luisjosedl
 * Source / updates: https://github.com/luisjosedl/pi-star-recompose
 * ============================================================================
 * MIT License
 *
 * Copyright (c) 2026 luisjosedl
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED.
 * ============================================================================
 * WHAT THIS SCRIPT DOES
 * ============================================================================
 *
 * Recomposes an already-stretched STARLESS image with a still-linear
 * STARS-ONLY image (typically the StarXTerminator / StarNet++ split).
 *
 * The stars are stretched using PixInsight's native ArcsinhStretch
 * (Lupton et al. 1999, "asinh magnitudes"), which is the gold-standard
 * stretch for stellar profiles: it preserves the RGB color ratios in
 * bright cores instead of crushing them to white the way a midtones
 * rational stretch (MTF) does. Color is then optionally boosted with a
 * symmetric ColorSaturation hat-curve and SCNR Green is offered as an
 * optional final cleanup.
 *
 * The processed stars are composited on top of the starless via
 *
 *     final = min( 1, starless + stars_proc )
 *
 * mirroring the classic "Star Recomposition" recipe popularised by
 * Siril, but with our own stretch engine.
 *
 * Optional second output: when "Save stretched stars" is enabled, the
 * stretched stars layer is also kept as a separate image so you can
 * use it as a brush layer, repeat the recompose with different
 * starless versions, or process further.
 *
 * Live embedded preview with mouse-wheel zoom and click-drag pan, and
 * an adaptive cache that rebuilds at the current dialog size so the
 * preview stays sharp when you enlarge the window.
 ******************************************************************************/

#feature-id    AstroDL > Star Recompose
#feature-info  Recompose a stretched starless image with a linear stars-only image using an ArcsinhStretch-based engine. Live embedded preview.

#include <pjsr/Sizer.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/UndoFlag.jsh>
#include <pjsr/KeyCodes.jsh>

#define BRAND         "AstroDL"
#define TOOL          "Star Recompose"
#define TITLE         "AstroDL - Star Recompose"
#define VERSION       "1.1.26"

// Preview cache sizing. The cache is rebuilt to match the current preview
// frame size (in physical pixels) so the image stays sharp when the dialog
// is enlarged. CACHE_MIN/CACHE_MAX bound the cost of the pipeline so
// slider drags stay responsive even on huge source images.
#define PREVIEW_MAX   800
#define CACHE_MIN     400
#define CACHE_MAX     2400

// Hidden cache window IDs. Prefix __AD_ keeps them out of the ViewCombo
// dropdowns and out of the user's workspace.
#define ID_SL_SMALL   "__AD_starless"
#define ID_ST_SMALL   "__AD_stars"
#define ID_STP_SMALL  "__AD_stars_proc"
#define ID_PV_SMALL   "__AD_preview"
#define ID_TMP_FULL   "__AD_proc_full"
#define ID_MASK         "__AD_mask"          // committed (red overlay)
#define ID_MASK_PENDING "__AD_mask_pend"     // brush/eraser pending (pink/cyan overlay)
#define ID_MASK_FULL    "__AD_mask_full"
#define ID_OVERLAY      "__AD_overlay"
#define ID_OVERLAY_PEND "__AD_overlay_pend"

// Mask defaults. Strength: 0..1, how much the mask attenuates the
// stars. Feather/Brush radii are expressed as a percentage of the
// image width so the visual size is resolution-independent.
// GradientCenter: 0..1, fraction of the shape's radius where the
// solid (mask=1) zone ends and the falloff to 0 begins. 1.0 means
// the shape is fully solid until its boundary (current behavior);
// 0.0 means the gradient starts from the center (no solid zone).
#define MASK_STRENGTH_DEF    1.0
#define MASK_FEATHER_DEF     2.0      // percent of image width
#define BRUSH_RADIUS_DEF     5.0      // percent of image width
#define GRADIENT_CENTER_DEF  1.0      // 0..1 (slider shows it as %)

// Slider ranges. STRETCH is the rational-stretch coefficient K in
//   y = (K * x) / ((K - 1) * x + 1)
// K=1 means no stretch, K large means an increasingly aggressive
// stretch concentrated in the dark end of the range (the bright cores
// are protected by the curve flattening out near x=1).
// BOOST is a multiplier for our ColorSaturation hat-curve.
#define STRETCH_MIN   1.0
#define STRETCH_MAX   1000.0
#define STRETCH_DEF   100.0

#define BOOST_MIN     0.0
#define BOOST_MAX     2.0
#define BOOST_DEF     1.0

// ===================== Model =====================

function CombinerData()
{
   this.starlessView  = null;
   this.starsView     = null;
   this.starlessSmall = null;
   this.starsSmall    = null;
   this.starsProc     = null;
   this.previewSmall  = null;

   this.stretchIntensity = STRETCH_DEF;
   this.colorBoost       = BOOST_DEF;
   this.removeGreen      = false;
   this.removeMagenta    = false;
   this.outputId         = "Combined";
   this.keepStars        = false;
   this.starsOutputId    = "Stars_Stretched";

   // Mask state (session-only, not persisted in the script instance).
   this.maskTool         = "pan";    // "pan" | "ellipse" | "rect" | "brush" | "eraser"
   this.maskStrength     = MASK_STRENGTH_DEF;
   this.maskFeatherPct   = MASK_FEATHER_DEF;
   this.brushRadiusPct   = BRUSH_RADIUS_DEF;
   this.maskGradientCtr  = GRADIENT_CENTER_DEF;  // 0..1, "solid core" fraction
   this.maskInvert       = false;
   this.maskPendingOverlayBitmap = null;
   this.maskOverlayBitmap = null;     // cached visualization bitmap
   // View mode for the preview area:
   //   "edit"   : recombined image + mask overlays/handles. Mask is
   //              NOT applied to the combine, so the underlying image
   //              stays fully visible. DEFAULT - best for editing.
   //   "result" : same overlays, BUT the mask IS applied so the user
   //              sees the actual masked result (what Apply produces).
   //   "mask"   : just the mask in grayscale (black = 0, white = 1).
   this.viewMode         = "edit";

   // Active editable shape (one at a time, drawn with the Ellipse or
   // Rect tool). Can be moved / resized / rotated until the user
   // clicks "Commit Shape" (or switches tools), at which point it is
   // rasterized into the permanent mask and cleared. Brush strokes
   // bypass this and go straight to the raster mask.
   //   {type:"ellipse"|"rect", cx, cy, rx, ry, angle, feather}
   this.activeShape      = null;

   // Persist current values into the script instance (the New Instance
   // triangle at the bottom-left drags a snapshot to the workspace).
   this.save = function()
   {
      Parameters.set( "stretchIntensity",  this.stretchIntensity );
      Parameters.set( "colorBoost",        this.colorBoost );
      Parameters.set( "removeGreen",       this.removeGreen );
      Parameters.set( "removeMagenta",     this.removeMagenta );
      Parameters.set( "outputId",          this.outputId );
      Parameters.set( "keepStars",        this.keepStars );
      Parameters.set( "starsOutputId",    this.starsOutputId );
   };

   // Restore values when the dialog is launched from a saved instance.
   // View IDs are deliberately not persisted: the user picks starless /
   // stars from the dropdowns on each run.
   this.load = function()
   {
      if ( Parameters.has( "stretchIntensity" ) )
         this.stretchIntensity = Parameters.getReal( "stretchIntensity" );
      if ( Parameters.has( "colorBoost" ) )
         this.colorBoost = Parameters.getReal( "colorBoost" );
      if ( Parameters.has( "removeGreen" ) )
         this.removeGreen = Parameters.getBoolean( "removeGreen" );
      if ( Parameters.has( "removeMagenta" ) )
         this.removeMagenta = Parameters.getBoolean( "removeMagenta" );
      if ( Parameters.has( "outputId" ) )
         this.outputId = Parameters.getString( "outputId" );
      if ( Parameters.has( "keepStars" ) )
         this.keepStars = Parameters.getBoolean( "keepStars" );
      if ( Parameters.has( "starsOutputId" ) )
         this.starsOutputId = Parameters.getString( "starsOutputId" );
   };
}

var data = new CombinerData();
var ui   = null;

// ===================== Cache helpers =====================

function closeWindowById( id )
{
   var w = ImageWindow.windowById( id );
   if ( !w.isNull ) w.forceClose();
}

// Force the ViewCombos to re-read the window list. Called every time we
// create or remove a cache window so the user's dropdowns stay clean.
function refreshViewCombos()
{
   if ( ui == null ) return;
   if ( ui.starlessViewList && ui.starlessViewList.refresh )
      ui.starlessViewList.refresh();
   if ( ui.starsViewList && ui.starsViewList.refresh )
      ui.starsViewList.refresh();
}

// ===================== ViewCombo: ComboBox filtered by ID prefix =====================
// PJSR.ViewList is auto-reactive and re-inserts hidden windows every
// time the dropdown is opened. We implement our own combo that walks
// ImageWindow.windows and excludes any IDs starting with "__AD_".
function ViewCombo( parent )
{
   this.__base__ = ComboBox;
   this.__base__( parent );

   this.editEnabled = false;
   var self = this;
   this._views         = [];          // parallel to dropdown items
   this._currentId     = null;        // remembers selection across refreshes
   this._excludePrefix = "__AD_";
   this.onViewSelected = null;        // assigned by the dialog

   this.refresh = function()
   {
      var prevId = this._currentId;
      // A live selection takes precedence over the stored _currentId.
      if ( this.currentItem > 0 && this._views[ this.currentItem - 1 ] )
         prevId = this._views[ this.currentItem - 1 ].id;

      this.clear();
      this._views = [];
      this.addItem( "<No View Selected>" );

      var sel = 0;
      var windows = ImageWindow.windows;
      for ( var i = 0; i < windows.length; ++i )
      {
         var v = windows[i].mainView;
         if ( v.id.indexOf( this._excludePrefix ) === 0 ) continue;
         this.addItem( v.id );
         this._views.push( v );
         if ( prevId === v.id ) sel = this._views.length;
      }
      this.currentItem = sel;
      this._currentId  = (sel > 0) ? this._views[ sel - 1 ].id : null;
   };

   this.getView = function()
   {
      var idx = this.currentItem;
      if ( idx > 0 && this._views[ idx - 1 ] )
         return this._views[ idx - 1 ];
      return null;
   };

   Object.defineProperty( this, "currentView", {
      get: function() { return self.getView(); },
      set: function( view )
      {
         if ( view == null || view.isNull )
            self._currentId = null;
         else
            self._currentId = view.id;
         self.refresh();
      }
   });

   this.onItemSelected = function( idx )
   {
      var v = self.getView();
      self._currentId = v ? v.id : null;
      if ( typeof self.onViewSelected === "function" )
         self.onViewSelected( v );
   };

   // Re-read the live window list right before showing the dropdown.
   this.onMousePress = function()
   {
      self.refresh();
   };

   this.refresh();
}
ViewCombo.prototype = new ComboBox;

// Build a downsampled cache window from a source view.
function buildSmall( srcView, targetId, maxSize )
{
   closeWindowById( targetId );
   if ( srcView == null || srcView.isNull ) return null;

   var src   = srcView.image;
   var scale = Math.min( maxSize / src.width, maxSize / src.height, 1.0 );
   var w     = Math.max( 1, Math.round( src.width  * scale ) );
   var h     = Math.max( 1, Math.round( src.height * scale ) );

   var nw = new ImageWindow(
      src.width, src.height,
      src.numberOfChannels,
      32, true,
      src.numberOfChannels > 1,
      targetId
   );
   refreshViewCombos();
   nw.mainView.beginProcess( UndoFlag_NoSwapFile );
   nw.mainView.image.assign( src );
   nw.mainView.endProcess();

   if ( scale < 1.0 )
   {
      var R = new Resample;
      R.xSize         = w;
      R.ySize         = h;
      R.mode          = Resample.prototype.AbsolutePixels;
      R.absoluteMode  = Resample.prototype.ForceWidthAndHeight;
      R.interpolation = Resample.prototype.Bilinear;
      R.executeOn( nw.mainView, false );
   }
   return nw;
}

// Ensure a window with the given ID exists and matches the reference
// image's dimensions. Recreated if dims differ.
function ensureMatchingWindow( id, refImage )
{
   var w = ImageWindow.windowById( id );
   if ( !w.isNull )
   {
      var im = w.mainView.image;
      if ( im.width != refImage.width
        || im.height != refImage.height
        || im.numberOfChannels != refImage.numberOfChannels )
      {
         w.forceClose();
         w = ImageWindow.windowById( id );
      }
   }
   if ( w.isNull )
   {
      w = new ImageWindow(
         refImage.width, refImage.height,
         refImage.numberOfChannels,
         32, true,
         refImage.numberOfChannels > 1,
         id );
      refreshViewCombos();
   }
   return w;
}

// Resample stars_small to match starless_small dimensions when the user
// picks views with slightly different sizes (e.g. cropped variants).
function ensureStarsSmallMatches()
{
   if ( data.starsSmall == null || data.starlessSmall == null ) return;
   var st = data.starsSmall.mainView.image;
   var sl = data.starlessSmall.mainView.image;
   if ( st.width == sl.width && st.height == sl.height )
      return;
   var R = new Resample;
   R.xSize         = sl.width;
   R.ySize         = sl.height;
   R.mode          = Resample.prototype.AbsolutePixels;
   R.absoluteMode  = Resample.prototype.ForceWidthAndHeight;
   R.interpolation = Resample.prototype.Bilinear;
   R.executeOn( data.starsSmall.mainView, false );
}

// ===================== Adaptive cache size =====================

var __cacheSize = PREVIEW_MAX;

function computeCacheMaxSize()
{
   if ( ui == null || ui.previewFrame == null )
      return PREVIEW_MAX;

   var fw = ui.previewFrame.width;
   var fh = ui.previewFrame.height;
   if ( fw < 50 || fh < 50 )
      return PREVIEW_MAX;

   var dpr = ui.previewFrame.displayPixelRatio;
   if ( dpr == null || isNaN( dpr ) || dpr < 1 ) dpr = 1;

   var target = Math.max( fw, fh ) * dpr;
   target = Math.ceil( target / 100 ) * 100;
   target = Math.max( CACHE_MIN, Math.min( CACHE_MAX, target ) );

   if ( data.starlessView != null && !data.starlessView.isNull )
   {
      var srcMax = Math.max( data.starlessView.image.width,
                             data.starlessView.image.height );
      target = Math.min( target, srcMax );
   }
   return target;
}

function syncCacheAndPreview()
{
   var newSize = computeCacheMaxSize();
   if ( Math.abs( newSize - __cacheSize ) >= 50 )
   {
      __cacheSize = newSize;
      if ( data.starlessView != null && !data.starlessView.isNull )
         data.starlessSmall = buildSmall( data.starlessView, ID_SL_SMALL, __cacheSize );
      if ( data.starsView != null && !data.starsView.isNull )
         data.starsSmall = buildSmall( data.starsView, ID_ST_SMALL, __cacheSize );
      closeWindowById( ID_STP_SMALL );
      closeWindowById( ID_PV_SMALL );
      // Resample the mask too so the user's painted shapes stay
      // visually anchored to the same regions of the image.
      if ( data.starlessSmall != null )
      {
         var sl = data.starlessSmall.mainView.image;
         resampleMaskTo( sl.width, sl.height );
         rebuildMaskOverlay();
      }
   }
   updatePreview();
}

var __resizeTimer = null;
function scheduleResize()
{
   if ( __resizeTimer == null )
   {
      __resizeTimer = new Timer( 0.25, false );
      __resizeTimer.onTimeout = function() { syncCacheAndPreview(); };
   }
   __resizeTimer.start();
}

// ===================== Pipeline (AstroDL engine, no third-party IP) =====================

// 1. Copy source image into the destination view in place. ArcsinhStretch
//    operates in-place, so we always work on a temporary copy that we own.
function copyInto( srcId, destView )
{
   var src = ImageWindow.windowById( srcId );
   if ( src.isNull )
      throw new Error( "Source window not found: " + srcId );
   destView.beginProcess( UndoFlag_NoSwapFile );
   destView.image.assign( src.mainView.image );
   destView.endProcess();
}

// 2. Rational stretch via PixelMath, applied independently per RGB
//    channel (so bright stars keep their distinct colors - blue, yellow,
//    orange stars stand out).
//
//    Formula:  y = (K * x) / ((K - 1) * x + 1)
//
//    This is a one-parameter Mobius transformation. It is mathematically
//    identical to PixInsight's MidtonesTransferFunction with a specific
//    midtones value, and to the "rational" stretches widely used in
//    astrophotography (Lodriguss, Marek, etc). The math itself is not
//    copyrightable - it has been used in tone-mapping since the 1970s.
//
//    Behavior:
//      K = 1     no stretch (y = x)
//      K = 100   typical default (good for moderately stretched stars)
//      K = 1000  very aggressive (blows out bright cores)
//
//    Per-channel application gives the punchy, colorful look users
//    typically want for stars layers.
function applyStretch( view, K )
{
   if ( K < 1.001 ) return;     // K = 1 is identity
   var pm = new PixelMath;
   pm.expression = "(" + K.toFixed( 4 ) + "*$T)/((" +
                   (K - 1).toFixed( 4 ) + ")*$T+1)";
   pm.useSingleExpression = true;
   pm.createNewImage      = false;
   pm.generateOutput      = true;
   pm.singleThreaded      = false;
   pm.optimization        = true;
   pm.rescale             = false;
   pm.truncate            = true;
   pm.truncateLower       = 0.0;
   pm.truncateUpper       = 1.0;
   pm.executeOn( view, false );
}

// 3. ColorSaturation hat-curve (AstroDL values, no third-party IP).
//    More saturation in midtones than at extremes so we don't push
//    shadows/highlights into noisy or clipped territory.
function applyColorSat( view, boost )
{
   var CS = new ColorSaturation;
   CS.HS = [
      [ 0.00000, boost * 0.50000 ],
      [ 0.50000, boost * 0.85000 ],
      [ 1.00000, boost * 0.50000 ]
   ];
   CS.HSt      = ColorSaturation.prototype.AkimaSubsplines;
   CS.hueShift = 0.000;
   CS.executeOn( view, false );
}

// 4. SCNR - native PI process (Russell Croman). Removes the chosen
// chrominance cast (Green is the most common in OSC astrophoto, but
// Magenta also helps cameras that over-correct green).
function applySCNR( view, channel )
{
   var P = new SCNR;
   P.amount             = 1.00;
   P.protectionMethod   = SCNR.prototype.AverageNeutral;
   P.colorToRemove      = channel;
   P.preserveLightness  = true;
   P.executeOn( view, false );
}

// Build the "effective mask" sub-expression by combining ANY of the
// three contributors via max(): the committed raster mask, the
// pending raster brush mass, and the active shape's inline expression.
// Returns null if none contribute.
function buildEffectiveMaskExpr( maskId, pendingId, activeExpr )
{
   var parts = [];
   if ( maskId    != null ) parts.push( maskId );
   if ( pendingId != null ) parts.push( pendingId );
   if ( activeExpr != null ) parts.push( activeExpr );
   if ( parts.length === 0 ) return null;
   if ( parts.length === 1 ) return parts[0];
   return "max(" + parts.join( "," ) + ")";
}

// 5. Combine:  destView = min(1, starless + starsProcessed * weight)
//    where weight = 1                       (no mask)
//                 = (1 - mask * strength)   (normal mask: hide stars where painted)
//                 = (1 - (1 - mask) * strength)  (inverted mask: keep stars only
//                                                  where painted)
function applyCombineWithMask( starlessId, starsProcId, maskId, pendingId,
                               activeExpr, strength, invert, destView )
{
   var effective = buildEffectiveMaskExpr( maskId, pendingId, activeExpr );

   var pm = new PixelMath;
   if ( effective == null || strength <= 0 )
   {
      pm.expression = "min(1," + starlessId + "+" + starsProcId + ")";
   }
   else
   {
      var maskTerm = invert
         ? "(1-(1-" + effective + ")*" + strength.toFixed( 4 ) + ")"
         : "(1-"      + effective + "*"     + strength.toFixed( 4 ) + ")";
      pm.expression = "min(1," + starlessId + "+" + starsProcId + "*" + maskTerm + ")";
   }
   pm.useSingleExpression = true;
   pm.createNewImage      = false;
   pm.generateOutput      = true;
   pm.singleThreaded      = false;
   pm.optimization        = true;
   pm.rescale             = false;
   pm.truncate            = true;
   pm.truncateLower       = 0.0;
   pm.truncateUpper       = 1.0;
   pm.executeOn( destView, false );
}

// ===================== Mask helpers =====================

// True if the mask window exists and is the same size as the starless
// cache, so it can be used in the combine PixelMath as ID_MASK.
function maskIsActive()
{
   var mw = ImageWindow.windowById( ID_MASK );
   if ( mw.isNull ) return false;
   if ( data.starlessSmall == null ) return false;
   var mi = mw.mainView.image;
   var si = data.starlessSmall.mainView.image;
   return mi.width === si.width && mi.height === si.height;
}

// Ensure the mask window exists at the current preview cache size.
// Created blank (filled with 0). Returns null if there's no starless yet.
function ensureMaskWindow()
{
   if ( data.starlessSmall == null ) return null;
   var sl = data.starlessSmall.mainView.image;
   var w  = ImageWindow.windowById( ID_MASK );
   if ( !w.isNull )
   {
      var im = w.mainView.image;
      if ( im.width === sl.width && im.height === sl.height )
         return w;
      w.forceClose();
   }
   w = new ImageWindow( sl.width, sl.height, 1, 32, true, false, ID_MASK );
   refreshViewCombos();
   // Fill with zero
   var pm = new PixelMath;
   pm.expression          = "0";
   pm.useSingleExpression = true;
   pm.createNewImage      = false;
   pm.generateOutput      = true;
   pm.executeOn( w.mainView, false );
   return w;
}

// Zero the mask out and clear the cached overlay bitmap.
function clearMask()
{
   var w = ImageWindow.windowById( ID_MASK );
   if ( !w.isNull )
   {
      var pm = new PixelMath;
      pm.expression          = "0";
      pm.useSingleExpression = true;
      pm.createNewImage      = false;
      pm.generateOutput      = true;
      pm.executeOn( w.mainView, false );
   }
   data.maskOverlayBitmap = null;
}

// Ensure the PENDING mask window exists at the preview cache size.
// Created blank. Returns null if no starless yet.
function ensureMaskPendingWindow()
{
   if ( data.starlessSmall == null ) return null;
   var sl = data.starlessSmall.mainView.image;
   var w  = ImageWindow.windowById( ID_MASK_PENDING );
   if ( !w.isNull )
   {
      var im = w.mainView.image;
      if ( im.width === sl.width && im.height === sl.height )
         return w;
      w.forceClose();
   }
   w = new ImageWindow( sl.width, sl.height, 1, 32, true, false,
                        ID_MASK_PENDING );
   refreshViewCombos();
   var pm = new PixelMath;
   pm.expression          = "0";
   pm.useSingleExpression = true;
   pm.createNewImage      = false;
   pm.generateOutput      = true;
   pm.executeOn( w.mainView, false );
   return w;
}

// Clear PENDING and its cached overlay bitmap.
function clearMaskPending()
{
   var w = ImageWindow.windowById( ID_MASK_PENDING );
   if ( !w.isNull )
   {
      var pm = new PixelMath;
      pm.expression          = "0";
      pm.useSingleExpression = true;
      pm.createNewImage      = false;
      pm.generateOutput      = true;
      pm.executeOn( w.mainView, false );
   }
   data.maskPendingOverlayBitmap = null;
}

// True if the PENDING mask has content (matching the cache size).
function pendingMaskIsActive()
{
   var pw = ImageWindow.windowById( ID_MASK_PENDING );
   if ( pw.isNull ) return false;
   if ( data.starlessSmall == null ) return false;
   var pi = pw.mainView.image;
   var si = data.starlessSmall.mainView.image;
   return pi.width === si.width && pi.height === si.height;
}

// Merge PENDING into MASK using max() then zero PENDING.
function mergePendingIntoMask()
{
   var pw = ImageWindow.windowById( ID_MASK_PENDING );
   if ( pw.isNull ) return;
   var mw = ensureMaskWindow();
   if ( mw == null ) return;
   var pm = new PixelMath;
   pm.expression          = "max($T," + ID_MASK_PENDING + ")";
   pm.useSingleExpression = true;
   pm.createNewImage      = false;
   pm.generateOutput      = true;
   pm.truncate            = true;
   pm.truncateLower       = 0.0;
   pm.truncateUpper       = 1.0;
   pm.executeOn( mw.mainView, false );
   clearMaskPending();
}

// Build the pink/cyan overlay bitmap for PENDING mask. Uses the same
// trick as rebuildMaskOverlay but the tint color comes from the
// current accent (cyan in Invert mode, pink otherwise).
function rebuildPendingOverlay()
{
   closeWindowById( ID_OVERLAY_PEND );
   var pw = ImageWindow.windowById( ID_MASK_PENDING );
   if ( pw.isNull )
   {
      data.maskPendingOverlayBitmap = null;
      return;
   }
   try
   {
      // Boosted vivid pink / cyan so the pending overlay shows up
      // even on bright preview pixels. Output channels are clamped
      // to 1 by PixelMath's truncate setting (newImage*Format=3 +
      // truncate=true), so values >1 just saturate gracefully.
      var rExpr, gExpr, bExpr;
      if ( data.maskInvert )
      {
         // Vivid cyan-ish blue.
         rExpr = "0.20*" + ID_MASK_PENDING;
         gExpr = "1.10*" + ID_MASK_PENDING;
         bExpr = "1.50*" + ID_MASK_PENDING;
      }
      else
      {
         // Vivid hot pink / magenta.
         rExpr = "1.50*" + ID_MASK_PENDING;
         gExpr = "0.20*" + ID_MASK_PENDING;
         bExpr = "0.70*" + ID_MASK_PENDING;
      }
      var pm = new PixelMath;
      pm.useSingleExpression  = false;
      pm.expression0          = rExpr;
      pm.expression1          = gExpr;
      pm.expression2          = bExpr;
      pm.createNewImage       = true;
      pm.newImageId           = ID_OVERLAY_PEND;
      pm.newImageColorSpace   = 1;
      pm.newImageSampleFormat = 3;
      pm.showNewImage         = false;
      pm.truncate             = true;
      pm.truncateLower        = 0.0;
      pm.truncateUpper        = 1.0;
      pm.executeOn( pw.mainView, false );
      refreshViewCombos();
      var ow = ImageWindow.windowById( ID_OVERLAY_PEND );
      if ( !ow.isNull )
      {
         data.maskPendingOverlayBitmap = ow.mainView.image.render();
         ow.forceClose();
      }
   }
   catch ( e )
   {
      console.warningln( "* pending overlay: " + e.message );
      data.maskPendingOverlayBitmap = null;
   }
}

// If the cache was resampled to a different size, resample the mask
// too so existing painted areas keep their visual location.
function resampleMaskTo( newWidth, newHeight )
{
   var w = ImageWindow.windowById( ID_MASK );
   if ( w.isNull ) return;
   var im = w.mainView.image;
   if ( im.width === newWidth && im.height === newHeight ) return;
   var R = new Resample;
   R.xSize         = newWidth;
   R.ySize         = newHeight;
   R.mode          = Resample.prototype.AbsolutePixels;
   R.absoluteMode  = Resample.prototype.ForceWidthAndHeight;
   R.interpolation = Resample.prototype.Bilinear;
   R.executeOn( w.mainView, false );
}

// Build the feathered-ellipse mask expression with a configurable
// "gradient center" (gc, 0..1). gc = 1.0 reproduces the previous
// behavior (solid mask=1 until the boundary, falloff outside over
// `feather` pixels). gc = 0 makes the gradient start from the center.
// Returns a PixelMath sub-expression evaluating to 0..1 per pixel.
function ellipseValueExpr( cx, cy, rx, ry, feather, angleRad, gc )
{
   rx = Math.max( 0.5, rx );
   ry = Math.max( 0.5, ry );
   var f = Math.max( 0.5, feather );
   var fnorm = f / Math.min( rx, ry );
   gc = Math.max( 0, Math.min( 1, gc ) );

   var lxExpr, lyExpr;
   if ( angleRad && Math.abs( angleRad ) > 1e-6 )
   {
      var co = Math.cos( angleRad ).toFixed( 6 );
      var si = Math.sin( angleRad ).toFixed( 6 );
      lxExpr = "((x()-(" + cx.toFixed(2) + "))*" + co +
               "+(y()-(" + cy.toFixed(2) + "))*" + si + ")";
      lyExpr = "(-(x()-(" + cx.toFixed(2) + "))*" + si +
                "+(y()-(" + cy.toFixed(2) + "))*" + co + ")";
   }
   else
   {
      lxExpr = "(x()-" + cx.toFixed(2) + ")";
      lyExpr = "(y()-" + cy.toFixed(2) + ")";
   }
   var ax = "(" + lxExpr + "/" + rx.toFixed( 4 ) + ")";
   var ay = "(" + lyExpr + "/" + ry.toFixed( 4 ) + ")";
   var dist  = "sqrt(" + ax + "*" + ax + "+" + ay + "*" + ay + ")";
   var rangeEnd = 1 + fnorm;
   var denom    = (rangeEnd - gc).toFixed( 6 );
   if ( rangeEnd - gc < 1e-6 )
   {
      // Avoid divide-by-zero with a hard step: 1 inside, 0 outside.
      return "iif(" + dist + "<=" + gc.toFixed(6) + ",1,0)";
   }
   return "max(0,min(1,1-(" + dist + "-" + gc.toFixed(6) + ")/" + denom + "))";
}

// Paint a feathered ellipse / circle into a SPECIFIC target window
// using max() blend. Target = MASK or MASK_PENDING window.
function paintEllipseToWindow( targetWindow, cx, cy, rx, ry, feather, gc )
{
   if ( targetWindow == null || targetWindow.isNull ) return;
   var value = ellipseValueExpr( cx, cy, rx, ry, feather, 0, gc );
   var pm = new PixelMath;
   pm.expression          = "max($T," + value + ")";
   pm.useSingleExpression = true;
   pm.createNewImage      = false;
   pm.generateOutput      = true;
   pm.singleThreaded      = false;
   pm.optimization        = true;
   pm.rescale             = false;
   pm.truncate            = true;
   pm.truncateLower       = 0.0;
   pm.truncateUpper       = 1.0;
   pm.executeOn( targetWindow.mainView, false );
}

// Throttle for brush/eraser PixelMath calls. PixelMath on the full
// mask image takes ~10-50 ms per dab. Without throttling, fast drag
// events stack up faster than they can complete, locking the PI
// view and lagging the UI. This timestamp limits paints to ~25 Hz.
var __lastMaskPaintTime = 0;
var MASK_PAINT_INTERVAL = 40;     // ms

// Reentrancy guard for brush/eraser PixelMath calls. PixInsight's
// PixelMath.executeOn() internally pumps the event loop to keep the
// UI responsive, which can fire the next mouseMove event mid-execute.
// That nested call then tries to lock the same view ("__AD_mask_pend")
// while it's still locked from the outer call, producing:
//   "The view is already locked for write operations: __AD_mask_pend"
// The flag below short-circuits the inner call. Returns true if the
// paint actually ran, false if it was skipped. Callers can use the
// return value to keep their trail in sync with the actual mask.
var __maskPainting = false;

// Paint a feathered circle (brush stroke) into the PENDING mask
// (not the committed one). The user can then accept the strokes via
// "Apply Edits" or undo them by clearing pending.
function paintCircleToPending( cx, cy, radius, feather )
{
   if ( __maskPainting ) return false;
   __maskPainting = true;
   try
   {
      var w = ensureMaskPendingWindow();
      if ( w == null ) return false;
      paintEllipseToWindow( w, cx, cy, radius, radius, feather,
                            data.maskGradientCtr );
      return true;
   }
   finally
   {
      __maskPainting = false;
   }
}

// Erase a feathered circle from BOTH the committed mask and the
// pending mask. Erasing both means the eraser is effective regardless
// of whether the user has already committed earlier strokes or not.
function eraseCircleFromMasks( cx, cy, radius, feather )
{
   if ( __maskPainting ) return false;
   __maskPainting = true;
   try
   {
      var r = Math.max( 0.5, radius );
      var value = ellipseValueExpr( cx, cy, r, r, feather, 0,
                                    data.maskGradientCtr );
      var expr = "max(0,$T-" + value + ")";

      var targets = [
         ImageWindow.windowById( ID_MASK ),
         ImageWindow.windowById( ID_MASK_PENDING )
      ];
      for ( var i = 0; i < targets.length; ++i )
      {
         var w = targets[i];
         if ( w == null || w.isNull ) continue;
         var pm = new PixelMath;
         pm.expression          = expr;
         pm.useSingleExpression = true;
         pm.createNewImage      = false;
         pm.generateOutput      = true;
         pm.singleThreaded      = false;
         pm.optimization        = true;
         pm.rescale             = false;
         pm.truncate            = true;
         pm.truncateLower       = 0.0;
         pm.truncateUpper       = 1.0;
         pm.executeOn( w.mainView, false );
      }
      return true;
   }
   finally
   {
      __maskPainting = false;
   }
}

// Rebuild the cached visualization bitmap of the mask. Uses PixelMath
// to build a red-tinted RGB image (R = mask, G = B = 0), then renders
// to a Bitmap. The bitmap is later drawn with CompositionOp_Plus so
// black areas (mask = 0) are visually transparent.
function rebuildMaskOverlay()
{
   closeWindowById( ID_OVERLAY );
   var maskW = ImageWindow.windowById( ID_MASK );
   if ( maskW.isNull )
   {
      data.maskOverlayBitmap = null;
      return;
   }
   try
   {
      var pm = new PixelMath;
      pm.useSingleExpression  = false;
      // Subtler red than before so bright preview content
      // (galaxies, nebulae) is not totally washed out red.
      pm.expression0          = "0.5*" + ID_MASK;
      pm.expression1          = "0";
      pm.expression2          = "0";
      pm.createNewImage       = true;
      pm.newImageId           = ID_OVERLAY;
      pm.newImageColorSpace   = 1;          // RGB
      pm.newImageSampleFormat = 3;          // 32-bit float
      pm.showNewImage         = false;
      pm.truncate             = true;
      pm.truncateLower        = 0.0;
      pm.truncateUpper        = 1.0;
      pm.executeOn( maskW.mainView, false );
      refreshViewCombos();

      var ow = ImageWindow.windowById( ID_OVERLAY );
      if ( !ow.isNull )
      {
         data.maskOverlayBitmap = ow.mainView.image.render();
         ow.forceClose();
      }
   }
   catch ( e )
   {
      console.warningln( "* mask overlay: " + e.message );
      data.maskOverlayBitmap = null;
   }
}

// Build a full-resolution mask by copying the preview-sized mask
// into a new window and resampling up. Used by Apply.
function buildFullResMask( fullW, fullH )
{
   var prevMask = ImageWindow.windowById( ID_MASK );
   if ( prevMask.isNull ) return null;
   closeWindowById( ID_MASK_FULL );
   var pm = prevMask.mainView.image;
   var w = new ImageWindow( pm.width, pm.height, 1, 32, true, false, ID_MASK_FULL );
   refreshViewCombos();
   w.mainView.beginProcess( UndoFlag_NoSwapFile );
   w.mainView.image.assign( pm );
   w.mainView.endProcess();
   if ( pm.width !== fullW || pm.height !== fullH )
   {
      var R = new Resample;
      R.xSize         = fullW;
      R.ySize         = fullH;
      R.mode          = Resample.prototype.AbsolutePixels;
      R.absoluteMode  = Resample.prototype.ForceWidthAndHeight;
      R.interpolation = Resample.prototype.Bilinear;
      R.executeOn( w.mainView, false );
   }
   return w;
}

// Convert a percent-of-image-width value to pixels for the given image width.
function pctToPx( pct, imageWidth )
{
   return Math.max( 0.5, imageWidth * pct / 100.0 );
}

// Smooth (Gaussian blur) the committed and pending mask windows in
// place. sigmaPct is expressed as a percentage of the image width so
// the effect is resolution-independent. Used by the "Smooth" button
// to "difuminar" (soften) hard edges left by brush strokes or after
// a quick committed shape.
function smoothMaskWindows( sigmaPct )
{
   if ( data.starlessSmall == null ) return;
   var imWid = data.starlessSmall.mainView.image.width;
   var sigma = Math.max( 0.5, Math.min( 40, imWid * sigmaPct / 100 ) );
   var ids = [ ID_MASK, ID_MASK_PENDING ];
   for ( var i = 0; i < ids.length; ++i )
   {
      var w = ImageWindow.windowById( ids[i] );
      if ( w.isNull ) continue;
      var conv = new Convolution;
      conv.mode          = Convolution.prototype.Parametric;
      conv.sigma         = sigma;
      conv.shape         = 2.0;            // Gaussian
      conv.aspectRatio   = 1.0;
      conv.rotationAngle = 0.0;
      conv.executeOn( w.mainView, false );
   }
}

// One-time console diagnostic on first paint: logs what PJSR actually
// stored in the Pen/Brush properties for our color values. If the
// colors keep coming out black, the console output will show whether
// the issue is at construction time, property assignment, or render.
var __colorDebugLogged = false;
function logColorDebug( color )
{
   if ( __colorDebugLogged ) return;
   __colorDebugLogged = true;
   try
   {
      console.show();
      console.writeln( "" );
      console.writeln( "============ AstroDL color diagnostic ============" );
      console.writeln( "Test color requested: 0x" + color.toString( 16 ) +
                       " (decimal " + color + ")" );
      var p1 = null;
      try { p1 = new Pen( color, 2.0 ); } catch ( e ) {
         console.writeln( "new Pen(color, 2.0) threw: " + e.message );
      }
      if ( p1 != null )
         console.writeln( "Pen ctor: pen.color = 0x" + p1.color.toString(16) +
                          ", pen.width = " + p1.width +
                          ", pen.style = " + p1.style );
      var p2 = new Pen();
      try { p2.color = color; } catch ( e ) {
         console.writeln( "pen.color = color threw: " + e.message );
      }
      console.writeln( "Property set: pen.color = 0x" + p2.color.toString(16) );
      var b1 = null;
      try { b1 = new Brush( color ); } catch ( e ) {
         console.writeln( "new Brush(color) threw: " + e.message );
      }
      if ( b1 != null )
         console.writeln( "Brush ctor: brush.color = 0x" + b1.color.toString(16) );
      console.writeln( "==================================================" );
   }
   catch ( ee ) { /* ignore logging errors */ }
}

// Defensive builders for Pen and Brush. PJSR has shown inconsistent
// behavior with the constructor's color argument; this sets the color
// both ways (constructor + property), and forces SolidLine style.
function makePen( color, width, style )
{
   var pen = null;
   try { pen = new Pen( color, width ); } catch ( e ) {}
   if ( pen == null ) pen = new Pen();
   try { pen.color = color; } catch ( e ) {}
   try { pen.width = width; } catch ( e ) {}
   try { pen.style = (style != null) ? style : 1; } catch ( e ) {}
   return pen;
}

function makeBrush( color )
{
   var brush = null;
   try { brush = new Brush( color ); } catch ( e ) {}
   if ( brush == null ) brush = new Brush();
   try { brush.color = color; } catch ( e ) {}
   return brush;
}

// =====================================================================
// Bitmap-based outline rendering. The Pen / Brush color APIs in PJSR
// were observed to render lines as opaque black on the user's PI
// build regardless of the requested color. To work around it we
// render the active shape overlay (outline + handles) into a
// transparent Bitmap via setPixel (which DOES honor colors) and then
// blit the bitmap onto the canvas via drawBitmap.
// =====================================================================

// Pack ARGB into a single uint32.
function argb( a, r, g, b )
{
   return ((a & 0xff) * 16777216)
        + ((r & 0xff) * 65536)
        + ((g & 0xff) * 256)
        +  (b & 0xff);
}

// Plot a single pixel safely (skips out-of-bounds coords).
function plotPixel( bmp, x, y, color )
{
   x = Math.round( x );
   y = Math.round( y );
   if ( x < 0 || y < 0 || x >= bmp.width || y >= bmp.height ) return;
   bmp.setPixel( x, y, color );
}

// Bresenham thick line on a Bitmap. Thickness is approximated by
// stamping a square at each Bresenham step.
function bmpThickLine( bmp, x1, y1, x2, y2, color, thickness )
{
   x1 = Math.round( x1 ); y1 = Math.round( y1 );
   x2 = Math.round( x2 ); y2 = Math.round( y2 );
   var dx = Math.abs( x2 - x1 ), dy = Math.abs( y2 - y1 );
   var sx = (x1 < x2) ? 1 : -1;
   var sy = (y1 < y2) ? 1 : -1;
   var err = dx - dy;
   var half = Math.max( 0, Math.floor( (thickness - 1) / 2 ) );
   while ( true )
   {
      for ( var oy = -half; oy <= half; ++oy )
         for ( var ox = -half; ox <= half; ++ox )
            plotPixel( bmp, x1 + ox, y1 + oy, color );
      if ( x1 === x2 && y1 === y2 ) break;
      var e2 = err * 2;
      if ( e2 > -dy ) { err -= dy; x1 += sx; }
      if ( e2 <  dx ) { err += dx; y1 += sy; }
   }
}

// Stroke a closed polygon onto a bitmap. If `dashed`, draws short
// dashes (4 px segments) along the path instead of a solid line.
function bmpStrokeClosedPath( bmp, pts, color, thickness, dashed )
{
   if ( pts == null || pts.length < 2 ) return;
   for ( var i = 0; i < pts.length; ++i )
   {
      var pa = pts[i];
      var pb = pts[ (i + 1) % pts.length ];
      if ( !dashed )
      {
         bmpThickLine( bmp, pa.x, pa.y, pb.x, pb.y, color, thickness );
      }
      else
      {
         var segLen = Math.sqrt( (pb.x - pa.x)*(pb.x - pa.x)
                               + (pb.y - pa.y)*(pb.y - pa.y) );
         var n = Math.max( 1, Math.floor( segLen / 4 ) );
         for ( var k = 0; k < n; ++k )
         {
            if ( k % 2 !== 0 ) continue;     // gap
            var t1 = k / n, t2 = (k + 1) / n;
            bmpThickLine( bmp,
               pa.x + (pb.x - pa.x) * t1, pa.y + (pb.y - pa.y) * t1,
               pa.x + (pb.x - pa.x) * t2, pa.y + (pb.y - pa.y) * t2,
               color, thickness );
         }
      }
   }
}

// Filled square handle (with outline).
function bmpFillRect( bmp, cx, cy, halfSize, fillColor, outlineColor )
{
   for ( var oy = -halfSize; oy <= halfSize; ++oy )
      for ( var ox = -halfSize; ox <= halfSize; ++ox )
      {
         var c = (Math.abs(ox) === halfSize || Math.abs(oy) === halfSize)
               ? outlineColor : fillColor;
         plotPixel( bmp, cx + ox, cy + oy, c );
      }
}

// Filled circle handle (with outline).
function bmpFillCircle( bmp, cx, cy, radius, fillColor, outlineColor )
{
   var r2 = radius * radius;
   var rIn2 = (radius - 1) * (radius - 1);
   for ( var oy = -radius; oy <= radius; ++oy )
      for ( var ox = -radius; ox <= radius; ++ox )
      {
         var d2 = ox*ox + oy*oy;
         if ( d2 > r2 ) continue;
         var c = (d2 > rIn2) ? outlineColor : fillColor;
         plotPixel( bmp, cx + ox, cy + oy, c );
      }
}

// =====================================================================
// Legacy Graphics-based stroke (kept available; not currently used).
// =====================================================================

function strokeClosedPathWithShadow( g, pts, mainColor, lineWidth, dashed )
{
   if ( pts == null || pts.length < 2 ) return;
   logColorDebug( mainColor );        // one-time PJSR color diagnostic
   try { g.antialiasing = true; } catch ( ae ) {}

   var penStyle  = dashed ? 2 : 1;
   var shadowPen = makePen( 0x7f000000, lineWidth + 1.5, penStyle );
   var colorPen  = makePen( mainColor,  lineWidth,        penStyle );

   // Preferred path: pen-only polygon stroke. Brush state is ignored.
   var useStroke = true;
   try
   {
      g.pen = shadowPen;
      g.strokePolygon( pts );
      g.pen = colorPen;
      g.strokePolygon( pts );
   }
   catch ( spe )
   {
      useStroke = false;
   }
   if ( useStroke ) return;

   // Fallback: explicit line loop.
   g.pen = shadowPen;
   for ( var i = 0; i < pts.length; ++i )
   {
      var pa = pts[i];
      var pb = pts[ (i + 1) % pts.length ];
      g.drawLine( pa.x, pa.y, pb.x, pb.y );
   }

   g.pen = colorPen;
   for ( var j = 0; j < pts.length; ++j )
   {
      var pc = pts[j];
      var pd = pts[ (j + 1) % pts.length ];
      g.drawLine( pc.x, pc.y, pd.x, pd.y );
   }
}

// ===================== Active shape =====================

// Build a PixelMath sub-expression (no surrounding "min(1,...)" or
// strength) that evaluates to the feathered mask of the active shape,
// 1 deep inside, falling off to 0 over `feather` pixels outside.
// Returns null when there is no active shape or the cache is missing.
function activeShapeMaskExpr()
{
   if ( data.activeShape == null ) return null;
   if ( data.starlessSmall == null ) return null;

   var s  = data.activeShape;
   var gc = (s.gradientCenter != null) ? s.gradientCenter
                                       : data.maskGradientCtr;

   if ( s.type === "ellipse" )
      return ellipseValueExpr( s.cx, s.cy, s.rx, s.ry, s.feather, s.angle, gc );

   if ( s.type === "rect" )
   {
      var f = Math.max( 0.5, s.feather );
      var rx = Math.max( 0.5, s.rx );
      var ry = Math.max( 0.5, s.ry );
      var co = Math.cos( s.angle ).toFixed( 6 );
      var si = Math.sin( s.angle ).toFixed( 6 );
      var lxExpr = "((x()-" + s.cx.toFixed(2) + ")*" + co +
                   "+(y()-" + s.cy.toFixed(2) + ")*" + si + ")";
      var lyExpr = "(-(x()-" + s.cx.toFixed(2) + ")*" + si +
                    "+(y()-" + s.cy.toFixed(2) + ")*" + co + ")";
      var dx = "max(0,abs(" + lxExpr + ")-" + rx.toFixed( 2 ) + ")";
      var dy = "max(0,abs(" + lyExpr + ")-" + ry.toFixed( 2 ) + ")";
      var dist = "sqrt(" + dx + "*" + dx + "+" + dy + "*" + dy + ")";
      return "max(0,min(1,1-" + dist + "/" + f.toFixed( 4 ) + "))";
   }
   return null;
}

// Bake the active shape into the persistent raster mask and clear it.
// Called from "Apply Edits" button and when the user switches tools.
function commitActiveShape()
{
   if ( data.activeShape == null ) return;
   var value = activeShapeMaskExpr();
   data.activeShape = null;       // clear FIRST so it isn't included twice
   var w = ensureMaskWindow();
   if ( w == null || value == null ) return;

   var pm = new PixelMath;
   pm.expression          = "max($T," + value + ")";
   pm.useSingleExpression = true;
   pm.createNewImage      = false;
   pm.generateOutput      = true;
   pm.truncate            = true;
   pm.truncateLower       = 0.0;
   pm.truncateUpper       = 1.0;
   pm.executeOn( w.mainView, false );
}

// Commit ALL pending edits (active shape + pending raster brush
// strokes) into the persistent mask, then clear both. Single button
// for the user since both are "edits in progress".
function commitAllPending()
{
   commitActiveShape();
   mergePendingIntoMask();
   rebuildMaskOverlay();
   data.maskPendingOverlayBitmap = null;
}

// True if there is anything pending to commit.
function hasPendingEdits()
{
   return data.activeShape != null || pendingMaskIsActive();
}

// Compute handle positions for the active shape in IMAGE coordinates.
// Returns an array of {x, y, mode} or an empty array.
// Modes: "resize-NW" / "NE" / "SE" / "SW" and "rotate".
function getActiveShapeHandles()
{
   var s = data.activeShape;
   if ( s == null ) return [];
   var co = Math.cos( s.angle );
   var si = Math.sin( s.angle );
   var rx = s.rx, ry = s.ry;
   // Rotation handle offset above the shape in the local +y direction.
   // (Image y grows DOWNWARD so the visual "above" is local -y.)
   var rotOffset = Math.max( 20, ry * 0.3 );
   var local = [
      { x: -rx, y: -ry,            mode: "resize-NW" },
      { x:  rx, y: -ry,            mode: "resize-NE" },
      { x:  rx, y:  ry,            mode: "resize-SE" },
      { x: -rx, y:  ry,            mode: "resize-SW" },
      { x:  0,  y: -(ry+rotOffset), mode: "rotate"    }
   ];
   var out = [];
   for ( var i = 0; i < local.length; ++i )
   {
      var lx = local[i].x, ly = local[i].y;
      var wx = lx * co - ly * si;
      var wy = lx * si + ly * co;
      out.push( { x: s.cx + wx, y: s.cy + wy, mode: local[i].mode } );
   }
   return out;
}

// Hit test: is image-coord (px, py) inside the active shape's body?
function pointInActiveShape( px, py )
{
   var s = data.activeShape;
   if ( s == null ) return false;
   var dx = px - s.cx;
   var dy = py - s.cy;
   var co = Math.cos( -s.angle );
   var si = Math.sin( -s.angle );
   var lx = dx * co - dy * si;
   var ly = dx * si + dy * co;
   if ( s.type === "ellipse" )
      return (lx/s.rx)*(lx/s.rx) + (ly/s.ry)*(ly/s.ry) < 1;
   return Math.abs( lx ) < s.rx && Math.abs( ly ) < s.ry;
}

// Discard the active shape without committing (e.g. user pressed ESC,
// or made a 1-pixel click without a meaningful drag).
function discardActiveShape()
{
   data.activeShape = null;
}

// Visual accent colors. NOTE on alpha: in PJSR, ARGB color literals
// with alpha 0x80..0xff are > 2^31 and JavaScript treats them as
// signed-int32 negatives, which PJSR's color bridge can sanitize to
// 0 (= black) for some draw calls. We deliberately use alpha 0x7f
// (50% opacity) so the value stays in int32 positive territory and
// renders reliably. We also pick PURE SATURATED RGB primaries so the
// lines are unmistakable on top of the preview.
//   Pink (magenta) = mask REMOVES stars in painted areas
//   Cyan           = mask KEEPS stars (invert mode)
//   White          = eraser
function maskAccentPen()
{
   if ( data.maskTool === "eraser" ) return 0x7fffffff;
   return data.maskInvert ? 0x7f00ffff : 0x7fff00ff;
}
function maskAccentFill()
{
   if ( data.maskTool === "eraser" ) return 0x40ffffff;
   return data.maskInvert ? 0x4000ffff : 0x40ff00ff;
}
function maskAccentSolid()
{
   if ( data.maskTool === "eraser" ) return 0x7fffffff;
   return data.maskInvert ? 0x7f00ffff : 0x7fff00ff;
}

// Update the Apply Edits button text + enabled state to reflect
// whether there are any pending edits (active shape OR brush strokes).
function updateCommitButton()
{
   if ( ui == null || ui.maskCommitBtn == null ) return;
   if ( hasPendingEdits() )
   {
      ui.maskCommitBtn.text    = "Apply Edits";
      ui.maskCommitBtn.enabled = true;
   }
   else
   {
      ui.maskCommitBtn.text    = "(no edits)";
      ui.maskCommitBtn.enabled = false;
   }
}

// Show or hide the three mask parameter rows based on the current tool.
// When the user has the Pan view selected (mask "off"), the rows are
// hidden to declutter the dialog. Uses hide()/show() because the
// `.visible` property doesn't propagate to the sizer in PJSR.
function updateMaskRowsVisibility()
{
   if ( ui == null ) return;
   var paramVisible    = (data.maskTool !== "pan");
   // Gradient Center is meaningful for ellipse only (rectangle has
   // no radial geometry).
   var gradientVisible = (data.maskTool === "ellipse");
   if ( ui.maskStrengthNC )
      paramVisible ? ui.maskStrengthNC.show() : ui.maskStrengthNC.hide();
   if ( ui.maskFeatherNC )
      paramVisible ? ui.maskFeatherNC.show() : ui.maskFeatherNC.hide();
   if ( ui.gradientCtrNC )
      gradientVisible ? ui.gradientCtrNC.show() : ui.gradientCtrNC.hide();
   // Brush Radius is permanently hidden (Brush tool disabled).
   if ( ui.brushRadiusNC ) ui.brushRadiusNC.hide();
}

// Run the full pipeline:
// copy stars -> arcsinh -> (sat + scnr) -> combine.
// If useMask is true, the mask (committed + pending + active shape) is
// applied to the combine; if false, the combine is the clean
// starless+stars sum (the editing overlay is still drawn on top by
// the canvas paint code).
function runPipeline( starlessId, starsSrcId, procView, targetView,
                     isColor, useMask )
{
   copyInto( starsSrcId, procView );
   applyStretch( procView, data.stretchIntensity );
   if ( isColor )
   {
      applyColorSat( procView, data.colorBoost );
      if ( data.removeGreen )
         applySCNR( procView, SCNR.prototype.Green );
      if ( data.removeMagenta )
         applySCNR( procView, SCNR.prototype.Magenta );
   }
   var maskId    = null, pendingId = null, activeExp = null;
   if ( useMask && data.maskStrength > 0 )
   {
      if ( maskIsActive() )         maskId    = ID_MASK;
      if ( pendingMaskIsActive() )  pendingId = ID_MASK_PENDING;
      if ( data.activeShape != null ) activeExp = activeShapeMaskExpr();
   }
   applyCombineWithMask( starlessId, procView.id, maskId, pendingId,
                         activeExp, data.maskStrength, data.maskInvert,
                         targetView );
}

// ===================== Live preview =====================

var __updating = false;
function updatePreview()
{
   if ( __updating ) return;
   if ( ui == null || ui.previewFrame == null ) return;

   if ( data.starlessSmall == null || data.starsSmall == null )
   {
      ui.previewFrame.setBitmap( null );
      return;
   }

   __updating = true;
   try
   {
      ensureStarsSmallMatches();
      var slIm = data.starlessSmall.mainView.image;
      data.starsProc    = ensureMatchingWindow( ID_STP_SMALL, slIm );
      data.previewSmall = ensureMatchingWindow( ID_PV_SMALL,  slIm );

      if ( data.viewMode === "mask" )
      {
         // Render the effective mask (raster + active shape) as a
         // grayscale image into the preview window. A scalar PixelMath
         // expression broadcast to a multi-channel target gives R=G=B
         // (i.e. B/W).
         var maskId    = maskIsActive() ? ID_MASK : null;
         var pendingId = pendingMaskIsActive() ? ID_MASK_PENDING : null;
         var activeExp = (data.activeShape != null) ? activeShapeMaskExpr() : null;
         var eff       = buildEffectiveMaskExpr( maskId, pendingId, activeExp );
         var pmMask = new PixelMath;
         pmMask.expression          = (eff != null) ? eff : "0";
         pmMask.useSingleExpression = true;
         pmMask.createNewImage      = false;
         pmMask.generateOutput      = true;
         pmMask.truncate            = true;
         pmMask.truncateLower       = 0.0;
         pmMask.truncateUpper       = 1.0;
         pmMask.executeOn( data.previewSmall.mainView, false );
      }
      else
      {
         // "edit" runs the combine WITHOUT mask (image stays visible
         // for alignment); "result" applies the mask so the user
         // sees the actual masked output.
         var isColor = data.starlessSmall.mainView.image.numberOfChannels > 1
                    && data.starsSmall.mainView.image.numberOfChannels   > 1;
         var useMask = (data.viewMode === "result");

         runPipeline(
            ID_SL_SMALL,
            ID_ST_SMALL,
            data.starsProc.mainView,
            data.previewSmall.mainView,
            isColor,
            useMask
         );
      }

      var bmp = data.previewSmall.mainView.image.render();
      ui.previewFrame.setBitmap( bmp );
   }
   catch ( e )
   {
      console.warningln( "* preview: " + e.message );
   }
   finally
   {
      __updating = false;
   }
}

// ===================== Apply at full resolution =====================

function applyFinal()
{
   if ( data.starlessView == null || data.starlessView.isNull )
   {
      console.warningln( "* Please select a Starless image." );
      return;
   }
   if ( data.starsView == null || data.starsView.isNull )
   {
      console.warningln( "* Please select a Stars image." );
      return;
   }
   var sl = data.starlessView.image;
   var st = data.starsView.image;
   if ( sl.width != st.width || sl.height != st.height )
   {
      console.criticalln( "** Starless and Stars must have the same dimensions." );
      return;
   }

   var isColor = sl.numberOfChannels > 1 && st.numberOfChannels > 1;
   var outId   = data.outputId.length > 0 ? data.outputId : "Combined";

   // Full-resolution temporary window where stars are processed.
   closeWindowById( ID_TMP_FULL );
   var tw = new ImageWindow(
      sl.width, sl.height,
      sl.numberOfChannels,
      32, true,
      sl.numberOfChannels > 1,
      ID_TMP_FULL );
   refreshViewCombos();

   var success        = false;
   var errMessage     = "";
   var keptStarsId    = "";
   var maskFullWindow = null;      // hoisted so finally can close it
   try
   {
      // Copy stars at full res into the temp window and run the stretch
      // pipeline on it (operates in-place).
      copyInto( data.starsView.id, tw.mainView );
      applyStretch( tw.mainView, data.stretchIntensity );
      if ( isColor )
      {
         applyColorSat( tw.mainView, data.colorBoost );
         if ( data.removeGreen )
            applySCNR( tw.mainView, SCNR.prototype.Green );
         if ( data.removeMagenta )
            applySCNR( tw.mainView, SCNR.prototype.Magenta );
      }

      // If the user painted a raster mask, build a full-resolution
      // version by resampling the preview-size mask up to source
      // dimensions. Build the active-shape full-res inline expression
      // by rescaling shape parameters (which were in preview coords)
      // to full-res coords.
      var maskExpr       = "";
      if ( data.maskStrength > 0 )
      {
         // Merge PENDING into MASK at the preview scale FIRST, so the
         // full-res resample picks up everything in one shot.
         if ( pendingMaskIsActive() )
         {
            mergePendingIntoMask();
            data.maskPendingOverlayBitmap = null;
         }

         var maskFullId = null;
         if ( maskIsActive() )
         {
            maskFullWindow = buildFullResMask( sl.width, sl.height );
            if ( maskFullWindow != null )
               maskFullId = ID_MASK_FULL;
         }

         var activeFullExpr = null;
         if ( data.activeShape != null && data.starlessSmall != null )
         {
            var prevW = data.starlessSmall.mainView.image.width;
            var scl   = sl.width / prevW;
            var s = data.activeShape;
            var orig = { cx:s.cx, cy:s.cy, rx:s.rx, ry:s.ry, feather:s.feather };
            s.cx      *= scl;
            s.cy      *= scl;
            s.rx      *= scl;
            s.ry      *= scl;
            s.feather *= scl;
            try {
               activeFullExpr = activeShapeMaskExpr();
            }
            finally {
               s.cx = orig.cx; s.cy = orig.cy;
               s.rx = orig.rx; s.ry = orig.ry;
               s.feather = orig.feather;
            }
         }

         var effective = buildEffectiveMaskExpr( maskFullId, null, activeFullExpr );
         if ( effective != null )
         {
            var str = data.maskStrength.toFixed( 4 );
            maskExpr = data.maskInvert
               ? "*(1-(1-" + effective + ")*" + str + ")"
               : "*(1-"      + effective + "*"     + str + ")";
         }
      }

      // Final combine creates the output image via createNewImage.
      var pm = new PixelMath;
      pm.expression           = "min(1," + data.starlessView.id
                              + "+" + ID_TMP_FULL + maskExpr + ")";
      pm.useSingleExpression  = true;
      pm.generateOutput       = true;
      pm.rescale              = false;
      pm.truncate             = true;
      pm.truncateLower        = 0.0;
      pm.truncateUpper        = 1.0;
      pm.createNewImage       = true;
      pm.newImageId           = outId;
      pm.newImageColorSpace   = isColor ? 1 : 0;
      pm.newImageSampleFormat = 3;
      pm.showNewImage         = true;
      pm.executeOn( data.starlessView, false );
      success = true;
   }
   catch ( e )
   {
      errMessage = e.message;
   }
   finally
   {
      // Always close the temporary full-res mask, even if the combine
      // PixelMath threw partway through.
      if ( maskFullWindow != null )
      {
         try { maskFullWindow.forceClose(); } catch ( ce ) { /* ignore */ }
         maskFullWindow = null;
      }

      // Either keep the stretched-stars image (renamed) or discard.
      if ( success && data.keepStars )
      {
         var baseId = data.starsOutputId.length > 0
                    ? data.starsOutputId
                    : "Stars_Stretched";
         var uniqueId = baseId;
         var n = 1;
         while ( !ImageWindow.windowById( uniqueId ).isNull )
            uniqueId = baseId + "_" + (n++);
         try
         {
            tw.mainView.id = uniqueId;
            tw.show();
            keptStarsId = uniqueId;
            refreshViewCombos();
         }
         catch ( e2 )
         {
            console.warningln( "* Could not keep stretched stars: " + e2.message );
            tw.forceClose();
         }
      }
      else
      {
         tw.forceClose();
      }
   }

   if ( success )
   {
      var msg = "<p>Combined image <b>" + outId + "</b> was created successfully.</p>";
      if ( keptStarsId.length > 0 )
         msg += "<p>Stretched stars image <b>" + keptStarsId + "</b> was also created.</p>";
      (new MessageBox(
         msg, TITLE + " v" + VERSION,
         StdIcon_Information, StdButton_Ok )).execute();
   }
   else
   {
      (new MessageBox(
         "<p>Apply failed:</p><p><b>" + errMessage + "</b></p>",
         TITLE + " v" + VERSION,
         StdIcon_Error, StdButton_Ok )).execute();
   }
}

// ===================== Cleanup =====================

function cleanup()
{
   closeWindowById( ID_SL_SMALL );
   closeWindowById( ID_ST_SMALL );
   closeWindowById( ID_STP_SMALL );
   closeWindowById( ID_PV_SMALL );
   closeWindowById( ID_TMP_FULL );
   closeWindowById( ID_MASK );
   closeWindowById( ID_MASK_PENDING );
   closeWindowById( ID_MASK_FULL );
   closeWindowById( ID_OVERLAY );
   closeWindowById( ID_OVERLAY_PEND );
   data.starlessSmall     = null;
   data.starsSmall        = null;
   data.starsProc         = null;
   data.previewSmall      = null;
   data.maskOverlayBitmap        = null;
   data.maskPendingOverlayBitmap = null;
   data.activeShape              = null;
}

// ===================== Debounce =====================

var __timer = null;
function scheduleUpdate()
{
   if ( __timer == null )
   {
      __timer = new Timer( 0.06, false );
      __timer.onTimeout = function() { updatePreview(); };
   }
   __timer.start();
}

// ===================== Preview Frame =====================

function PreviewFrame( parent )
{
   this.__base__ = Frame;
   this.__base__( parent );

   this.frameStyle = FrameStyle_Sunken;
   this.bitmap     = null;

   this.zoomFactor = 1.0;
   this.zoomMin    = 1.0;
   this.zoomMax    = 16.0;
   this.panX       = 0;
   this.panY       = 0;
   this._panning   = false;
   this._panStart  = { x: 0, y: 0, panX: 0, panY: 0 };

   // Mask drawing state (in IMAGE coordinates, relative to self.bitmap).
   this._drawStart   = null;       // {x, y} or null
   this._drawCurrent = null;
   this._cursorImg   = null;       // current mouse position in image coords
   this._brushTrail  = [];         // [{x, y, r, erasing}] for real-time
                                   // brush feedback; cleared on release

   this.setScaledMinSize( 520, 380 );
   this.cursor = new Cursor( StdCursor_OpenHand );

   // CRITICAL for hover cursors and the brush ring: without mouse
   // tracking, Qt only sends mouseMoveEvent while a button is held,
   // so cursors over handles wouldn't change. PJSR exposes this as
   // the `mouseTracking` property on Control; try a few names because
   // it has varied between versions.
   try { this.mouseTracking = true; } catch ( mt ) { /* ignore */ }
   try { this.trackingEnabled = true; } catch ( mt ) { /* ignore */ }

   var self = this;

   this._currentScale = function()
   {
      if ( self.bitmap == null ) return null;
      var fit = Math.min( self.width / self.bitmap.width,
                          self.height / self.bitmap.height );
      return fit * self.zoomFactor;
   };

   // Convert canvas (cx, cy) coordinates to image (bitmap) coordinates.
   // Returns null if the cursor is outside the displayed image or there
   // is no bitmap.
   this._canvasToImage = function( cx, cy )
   {
      if ( self.bitmap == null ) return null;
      var bw    = self.bitmap.width;
      var bh    = self.bitmap.height;
      var cw    = self.width;
      var ch    = self.height;
      var scale = self._currentScale();
      if ( scale == null || scale <= 0 ) return null;
      var dx = (cw - bw * scale) / 2 + self.panX;
      var dy = (ch - bh * scale) / 2 + self.panY;
      var ix = (cx - dx) / scale;
      var iy = (cy - dy) / scale;
      if ( ix < 0 || ix >= bw || iy < 0 || iy >= bh ) return null;
      return { x: ix, y: iy };
   };

   // Inverse of _canvasToImage: rectangle in canvas space for an image
   // rectangle. Used to paint rubber bands of in-progress shapes.
   this._imageRectToCanvas = function( x1, y1, x2, y2 )
   {
      if ( self.bitmap == null ) return null;
      var bw    = self.bitmap.width;
      var bh    = self.bitmap.height;
      var cw    = self.width;
      var ch    = self.height;
      var scale = self._currentScale();
      var dx = (cw - bw * scale) / 2 + self.panX;
      var dy = (ch - bh * scale) / 2 + self.panY;
      return new Rect( dx + x1 * scale, dy + y1 * scale,
                       dx + x2 * scale, dy + y2 * scale );
   };

   this.onPaint = function()
   {
      var g = new Graphics( self );
      try
      {
         g.fillRect( self.boundsRect, makeBrush( 0x7f181818 ) );
         if ( self.bitmap == null )
         {
            g.pen = makePen( 0x7f707070, 1.0 );
            g.drawTextRect(
               self.boundsRect,
               "Select a Starless and a Stars image",
               TextAlign_Center | TextAlign_VertCenter );
            return;
         }

         var bw    = self.bitmap.width;
         var bh    = self.bitmap.height;
         var cw    = self.width;
         var ch    = self.height;
         var scale = self._currentScale();
         var dw    = bw * scale;
         var dh    = bh * scale;
         var dx    = (cw - dw) / 2 + self.panX;
         var dy    = (ch - dh) / 2 + self.panY;
         var destRect = new Rect( dx, dy, dx + dw, dy + dh );

         // Base preview
         g.drawScaledBitmap( destRect, self.bitmap );

         // Mask overlays (red = committed, pink/cyan = pending) are
         // drawn for both "edit" and "result" view modes. "mask" mode
         // already shows the mask as the preview itself, so we skip
         // overlays there to avoid double-rendering.
         if ( data.viewMode === "edit" || data.viewMode === "result" )
         {
            try { g.compositionOperator = 12; } catch ( ce ) {}
            if ( data.maskOverlayBitmap != null )
            {
               try { g.drawScaledBitmap( destRect, data.maskOverlayBitmap ); }
               catch ( ce ) {}
            }
            if ( data.maskPendingOverlayBitmap != null )
            {
               try { g.drawScaledBitmap( destRect, data.maskPendingOverlayBitmap ); }
               catch ( ce ) {}
            }
            try { g.compositionOperator = 0; } catch ( ce ) {}
         }

         // Active shape (editable): outline + handles. Drawn on top of
         // any overlay so the user can always see and grab it. Only
         // shown for the geometric tools (ellipse / rect).
         if ( data.activeShape != null
           && (data.maskTool === "ellipse" || data.maskTool === "rect") )
         {
            var s = data.activeShape;
            // Build polygon points around the shape's local rim.
            var pts = [];
            var N = 64;
            var co = Math.cos( s.angle );
            var si = Math.sin( s.angle );
            if ( s.type === "ellipse" )
            {
               for ( var i = 0; i < N; ++i )
               {
                  var th = (i / N) * 2 * Math.PI;
                  var lx = s.rx * Math.cos( th );
                  var ly = s.ry * Math.sin( th );
                  var wx = s.cx + lx * co - ly * si;
                  var wy = s.cy + lx * si + ly * co;
                  var cp = self._imageRectToCanvas( wx, wy, wx, wy );
                  pts.push( new Point( cp.x0, cp.y0 ) );
               }
            }
            else
            {
               var local = [ [-s.rx, -s.ry], [s.rx, -s.ry],
                             [ s.rx,  s.ry], [-s.rx,  s.ry] ];
               for ( var k = 0; k < 4; ++k )
               {
                  var lx2 = local[k][0], ly2 = local[k][1];
                  var wx2 = s.cx + lx2 * co - ly2 * si;
                  var wy2 = s.cy + lx2 * si + ly2 * co;
                  var cp2 = self._imageRectToCanvas( wx2, wy2, wx2, wy2 );
                  pts.push( new Point( cp2.x0, cp2.y0 ) );
               }
            }
            // Render shape outline + handles into a transparent bitmap
            // and blit it onto the canvas. Pen / Brush colors were
            // observed to render as black on the user's PJSR build, so
            // we bypass the Pen API entirely and write pixel colors
            // directly via Bitmap.setPixel (which DOES honor colors,
            // as the preview itself proves).
            var cw = self.width, ch = self.height;
            var uiBmp = new Bitmap( cw, ch );
            uiBmp.fill( 0 );      // transparent

            // High-saturation red outline (no alpha issue: full opaque
            // is OK on Bitmap because we control the pixel values
            // directly, not going through Pen).
            var shadowColor = argb( 0xff, 0, 0, 0 );           // black
            var mainColor   = data.maskInvert
                            ? argb( 0xff, 0x00, 0xcc, 0xff )   // cyan
                            : argb( 0xff, 0xff, 0x00, 0x00 );  // RED

            // Main outline: shadow + colored stroke.
            bmpStrokeClosedPath( uiBmp, pts, shadowColor, 4, false );
            bmpStrokeClosedPath( uiBmp, pts, mainColor,   2, false );

            // Inner "core" contour (dashed).
            var gcShape = (s.gradientCenter != null)
                        ? s.gradientCenter : data.maskGradientCtr;
            if ( s.type === "ellipse" && gcShape < 0.99
              && gcShape * Math.min( s.rx, s.ry ) >= 1.0 )
            {
               var corePts = [];
               for ( var ci = 0; ci < N; ++ci )
               {
                  var cth = (ci / N) * 2 * Math.PI;
                  var clx = s.rx * gcShape * Math.cos( cth );
                  var cly = s.ry * gcShape * Math.sin( cth );
                  var cwx = s.cx + clx * co - cly * si;
                  var cwy = s.cy + clx * si + cly * co;
                  var ccp = self._imageRectToCanvas( cwx, cwy, cwx, cwy );
                  corePts.push( new Point( ccp.x0, ccp.y0 ) );
               }
               bmpStrokeClosedPath( uiBmp, corePts, shadowColor, 3, true );
               bmpStrokeClosedPath( uiBmp, corePts, mainColor,   1, true );
            }

            // Draw the 4 corner handles + the rotation handle.
            var handles = getActiveShapeHandles();
            var handleFill    = data.maskInvert
                              ? argb( 0xff, 0x00, 0xcc, 0xff )
                              : argb( 0xff, 0xff, 0x00, 0x00 );
            var handleOutline = argb( 0xff, 0xff, 0xff, 0xff );  // white
            var rotFill       = argb( 0xff, 0x22, 0xaa, 0x22 );  // green
            var rotOutline    = argb( 0xff, 0xff, 0xff, 0xff );

            for ( var h = 0; h < handles.length; ++h )
            {
               var hc = self._imageRectToCanvas(
                  handles[h].x, handles[h].y,
                  handles[h].x, handles[h].y );
               var hx = Math.round( hc.x0 ), hy = Math.round( hc.y0 );

               if ( handles[h].mode === "rotate" )
               {
                  // Stem connecting handle to the top center of the shape.
                  var localTopX = 0, localTopY = -s.ry;
                  var topWx = s.cx + localTopX * co - localTopY * si;
                  var topWy = s.cy + localTopX * si + localTopY * co;
                  var topC  = self._imageRectToCanvas( topWx, topWy, topWx, topWy );
                  bmpThickLine( uiBmp, topC.x0, topC.y0, hx, hy, rotFill, 2 );
                  bmpFillCircle( uiBmp, hx, hy, 8, rotFill, rotOutline );
               }
               else
               {
                  bmpFillRect( uiBmp, hx, hy, 5, handleFill, handleOutline );
               }
            }

            try { g.drawBitmap( 0, 0, uiBmp ); }
            catch ( de ) {
               try { g.drawBitmap( new Point( 0, 0 ), uiBmp ); }
               catch ( de2 ) {}
            }
         }

         // Real-time brush / eraser trail. While the user is dragging
         // a brush or eraser stroke, render each dab as a translucent
         // ring on the canvas so they get immediate visual feedback,
         // even though the actual mask overlay bitmap is only rebuilt
         // on mouse release (which is too slow per frame).
         if ( self._brushTrail.length > 0 )
         {
            g.brush = makeBrush( maskAccentFill() );
            g.pen   = makePen( maskAccentPen(), 1.0 );
            for ( var ti = 0; ti < self._brushTrail.length; ++ti )
            {
               var t = self._brushTrail[ti];
               var tc = self._imageRectToCanvas(
                  t.x - t.r, t.y - t.r,
                  t.x + t.r, t.y + t.r );
               g.drawEllipse( tc );
            }
         }

         // Brush / eraser cursor ring at the current mouse position.
         // Up to three rings:
         //   solid  = brush radius (where the stroke ends solidly)
         //   dashed = radius + feather (where the alpha falls to 0)
         //   dashed (innermost) = radius * gc (core of the gradient,
         //                                     where mask=1 ends)
         var isBrushyTool = (data.maskTool === "brush" || data.maskTool === "eraser");
         if ( isBrushyTool && self._cursorImg != null )
         {
            var radPx    = pctToPx( data.brushRadiusPct, bw );
            var feathPx  = pctToPx( data.maskFeatherPct, bw );
            var cInner = self._imageRectToCanvas(
               self._cursorImg.x - radPx,         self._cursorImg.y - radPx,
               self._cursorImg.x + radPx,         self._cursorImg.y + radPx );
            var cOuter = self._imageRectToCanvas(
               self._cursorImg.x - (radPx+feathPx), self._cursorImg.y - (radPx+feathPx),
               self._cursorImg.x + (radPx+feathPx), self._cursorImg.y + (radPx+feathPx) );
            g.brush = makeBrush( 0x00000000 );
            g.pen   = makePen( maskAccentPen(), 1.5 );
            g.drawEllipse( cInner );
            if ( feathPx > 0.5 )
            {
               g.pen = makePen( maskAccentPen(), 1.0, 2 );  // dashed
               g.drawEllipse( cOuter );
            }
            // Inner core ring (where solid mask=1 zone ends).
            if ( data.maskGradientCtr < 0.99 && data.maskGradientCtr * radPx >= 1 )
            {
               var coreRad = radPx * data.maskGradientCtr;
               var cCore = self._imageRectToCanvas(
                  self._cursorImg.x - coreRad, self._cursorImg.y - coreRad,
                  self._cursorImg.x + coreRad, self._cursorImg.y + coreRad );
               g.pen = makePen( maskAccentPen(), 1.0, 2 );  // dashed
               g.drawEllipse( cCore );
            }
         }
      }
      finally
      {
         g.end();
      }
   };

   this.setBitmap = function( bmp )
   {
      this.bitmap = bmp;
      this.repaint();
   };

   this.fitToFrame = function()
   {
      this.zoomFactor = 1.0;
      this.panX = 0;
      this.panY = 0;
      this.repaint();
   };

   this._zoomAt = function( cx, cy, factor )
   {
      if ( this.bitmap == null ) return;
      var newZoom = Math.max( this.zoomMin,
                              Math.min( this.zoomMax, this.zoomFactor * factor ) );
      if ( Math.abs( newZoom - this.zoomFactor ) < 1e-4 ) return;

      var bw  = this.bitmap.width;
      var bh  = this.bitmap.height;
      var cw  = this.width;
      var ch  = this.height;
      var fit = Math.min( cw / bw, ch / bh );
      var oldScale = fit * this.zoomFactor;
      var newScale = fit * newZoom;

      var oldDx = (cw - bw * oldScale) / 2 + this.panX;
      var oldDy = (ch - bh * oldScale) / 2 + this.panY;
      var bx = (cx - oldDx) / oldScale;
      var by = (cy - oldDy) / oldScale;

      var newDx = cx - bx * newScale;
      var newDy = cy - by * newScale;
      this.panX = newDx - (cw - bw * newScale) / 2;
      this.panY = newDy - (ch - bh * newScale) / 2;
      this.zoomFactor = newZoom;
      this.repaint();
   };

   this.zoomIn  = function() { self._zoomAt( self.width / 2, self.height / 2, 1.25 ); };
   this.zoomOut = function() { self._zoomAt( self.width / 2, self.height / 2, 0.80 ); };

   this.onMouseWheel = function( x, y, delta, buttons, modifiers )
   {
      // Wheel always zooms regardless of current tool.
      var factor = (delta > 0) ? 1.25 : 0.80;
      self._zoomAt( x, y, factor );
   };

   // Drag mode set in onMousePress, read in onMouseMove/onMouseRelease.
   //   null | "pan" | "draw" | "move"
   //   "resize-NW" | "resize-NE" | "resize-SE" | "resize-SW" | "rotate"
   this._dragMode      = null;
   this._dragShapeBak  = null;     // deep copy of activeShape at drag start

   // Track current standard cursor id to avoid recreating Cursor() on
   // every mouse move (cheap but adds up at 60+ Hz of motion events).
   this._lastCursorId = -999;
   this._setCursorId = function( stdId )
   {
      if ( self._lastCursorId === stdId ) return;
      self._lastCursorId = stdId;
      self.cursor = new Cursor( stdId );
   };

   // Map a hit-test mode string to a sensible PJSR standard cursor.
   this._modeToCursor = function( mode )
   {
      switch ( mode )
      {
         case "resize-NW":
         case "resize-SE": return StdCursor_SizeFDiag;
         case "resize-NE":
         case "resize-SW": return StdCursor_SizeBDiag;
         case "rotate":    return StdCursor_PointingHand;
         case "move":      return StdCursor_SizeAll;
      }
      return StdCursor_Cross;
   };

   // Hit-test (x,y) in canvas coords against the active shape's
   // handles (priority) then its body. Returns drag mode string or null.
   this._hitActiveShape = function( cx, cy )
   {
      if ( data.activeShape == null ) return null;
      var handles = getActiveShapeHandles();
      for ( var i = 0; i < handles.length; ++i )
      {
         var cp = self._imageRectToCanvas(
            handles[i].x, handles[i].y,
            handles[i].x, handles[i].y );
         var dx = cx - cp.x0;
         var dy = cy - cp.y0;
         if ( dx * dx + dy * dy <= 144 )       // 12-px hit radius
            return handles[i].mode;
      }
      var ip = self._canvasToImage( cx, cy );
      if ( ip != null && pointInActiveShape( ip.x, ip.y ) )
         return "move";
      return null;
   };

   this.onMousePress = function( x, y, button, buttons, modifiers )
   {
      // Pan tool: classic behavior.
      if ( data.maskTool === "pan" || self.bitmap == null )
      {
         self._dragMode      = "pan";
         self._panning       = true;
         self._panStart.x    = x;
         self._panStart.y    = y;
         self._panStart.panX = self.panX;
         self._panStart.panY = self.panY;
         self.cursor = new Cursor( StdCursor_ClosedHand );
         return;
      }

      // Brush / Eraser tool: paint immediately at the cursor.
      if ( data.maskTool === "brush" || data.maskTool === "eraser" )
      {
         var p0 = self._canvasToImage( x, y );
         if ( p0 == null ) return;
         self._dragMode    = "draw";
         self._drawStart   = p0;
         self._drawCurrent = p0;
         self._cursorImg   = p0;
         var radPx  = pctToPx( data.brushRadiusPct, self.bitmap.width );
         var feathr = pctToPx( data.maskFeatherPct, self.bitmap.width );
         if ( data.maskTool === "brush" )
            paintCircleToPending( p0.x, p0.y, radPx, feathr );
         else
            eraseCircleFromMasks( p0.x, p0.y, radPx, feathr );
         self._brushTrail = [ { x: p0.x, y: p0.y, r: radPx } ];
         scheduleUpdate();
         self.repaint();
         return;
      }

      // Ellipse / Rectangle: either grab a handle on the active shape,
      // or start drawing a new one. But if there's ALREADY an active
      // shape and the user clicks outside it, do NOTHING (don't
      // silently destroy their in-progress shape).
      var p = self._canvasToImage( x, y );
      if ( p == null ) return;

      var hit = self._hitActiveShape( x, y );
      if ( hit != null )
      {
         self._dragMode = hit;
         self._drawStart = p;
         self._dragShapeBak = {
            cx:     data.activeShape.cx,
            cy:     data.activeShape.cy,
            rx:     data.activeShape.rx,
            ry:     data.activeShape.ry,
            angle:  data.activeShape.angle
         };
         self._cursorImg = p;
         self.repaint();
         return;
      }

      if ( data.activeShape != null )
      {
         // Click missed the existing shape - keep it. To start a new
         // one the user must commit it (Apply Edits) or discard it
         // (ESC) first.
         return;
      }

      // No active shape -> create one.
      var feathr2 = pctToPx( data.maskFeatherPct, self.bitmap.width );
      data.activeShape = {
         type:           data.maskTool,    // "ellipse" or "rect"
         cx:             p.x,
         cy:             p.y,
         rx:             0.5,
         ry:             0.5,
         angle:          0,
         feather:        feathr2,
         gradientCenter: data.maskGradientCtr
      };
      self._dragMode    = "draw";
      self._drawStart   = p;
      self._drawCurrent = p;
      self._cursorImg   = p;

      // Auto-switch the Preview View to "Result" so the user sees the
      // mask effect immediately as they draw / edit the shape.
      if ( data.viewMode === "edit" && ui && ui.viewModeCombo )
      {
         data.viewMode = "result";
         ui.viewModeCombo.currentItem = 1;
      }

      updateCommitButton();
      scheduleUpdate();
      self.repaint();
   };

   this.onMouseMove = function( x, y, buttons, modifiers )
   {
      if ( self._dragMode === "pan" )
      {
         self.panX = self._panStart.panX + (x - self._panStart.x);
         self.panY = self._panStart.panY + (y - self._panStart.y);
         self.repaint();
         return;
      }

      var p = self._canvasToImage( x, y );
      self._cursorImg = p;

      if ( self._dragMode != null && p != null )
      {
         var isBrushy = (data.maskTool === "brush" || data.maskTool === "eraser");
         if ( isBrushy && self._dragMode === "draw" )
         {
            var radPx  = pctToPx( data.brushRadiusPct, self.bitmap.width );
            var feathr = pctToPx( data.maskFeatherPct, self.bitmap.width );
            // Throttled actual mask paint (keeps PC responsive).
            var now = Date.now();
            if ( now - __lastMaskPaintTime >= MASK_PAINT_INTERVAL )
            {
               __lastMaskPaintTime = now;
               if ( data.maskTool === "brush" )
                  paintCircleToPending( p.x, p.y, radPx, feathr );
               else
                  eraseCircleFromMasks( p.x, p.y, radPx, feathr );
               scheduleUpdate();
            }
            // The visual trail keeps recording every move, so the user
            // still gets smooth real-time feedback regardless of the
            // paint throttle.
            self._brushTrail.push( { x: p.x, y: p.y, r: radPx } );
         }
         else if ( data.activeShape != null )
         {
            var s = data.activeShape;
            if ( self._dragMode === "draw" )
            {
               if ( s.type === "ellipse" )
               {
                  // Major-axis-oriented: first click and drag endpoint
                  // become the two ends of the major axis. Minor axis
                  // defaults to 1/3 of the major (good for galaxies).
                  var dxa = p.x - self._drawStart.x;
                  var dya = p.y - self._drawStart.y;
                  var len = Math.sqrt( dxa*dxa + dya*dya );
                  s.cx = (self._drawStart.x + p.x) / 2;
                  s.cy = (self._drawStart.y + p.y) / 2;
                  s.rx = Math.max( 1, len / 2 );
                  s.ry = Math.max( 1, len / 6 );      // 3:1 default aspect
                  s.angle = (len > 0.5) ? Math.atan2( dya, dxa ) : 0;
               }
               else
               {
                  // Rectangle: bounding-box, two opposite corners.
                  s.cx = (self._drawStart.x + p.x) / 2;
                  s.cy = (self._drawStart.y + p.y) / 2;
                  s.rx = Math.max( 1, Math.abs( p.x - self._drawStart.x ) / 2 );
                  s.ry = Math.max( 1, Math.abs( p.y - self._drawStart.y ) / 2 );
                  s.angle = 0;
               }
            }
            else if ( self._dragMode === "move" )
            {
               s.cx = self._dragShapeBak.cx + (p.x - self._drawStart.x);
               s.cy = self._dragShapeBak.cy + (p.y - self._drawStart.y);
            }
            else if ( self._dragMode === "rotate" )
            {
               var dxr = p.x - s.cx, dyr = p.y - s.cy;
               // Rotation handle sits "above" shape (-y) when angle=0,
               // so a cursor at (-y) maps to angle = 0.
               s.angle = Math.atan2( dyr, dxr ) + Math.PI / 2;
            }
            else if ( self._dragMode.indexOf( "resize-" ) === 0 )
            {
               // Opposite corner stays fixed in IMAGE coords.
               var oppMap = { "resize-NW": 2, "resize-NE": 3,
                              "resize-SE": 0, "resize-SW": 1 };
               // We need the opposite handle in image coords using the
               // backup shape (the shape before this drag started).
               var bak = self._dragShapeBak;
               var co = Math.cos( bak.angle );
               var si = Math.sin( bak.angle );
               var lxOpp, lyOpp;
               switch ( self._dragMode )
               {
                  case "resize-NW": lxOpp =  bak.rx; lyOpp =  bak.ry; break;
                  case "resize-NE": lxOpp = -bak.rx; lyOpp =  bak.ry; break;
                  case "resize-SE": lxOpp = -bak.rx; lyOpp = -bak.ry; break;
                  case "resize-SW": lxOpp =  bak.rx; lyOpp = -bak.ry; break;
               }
               var oppX = bak.cx + lxOpp * co - lyOpp * si;
               var oppY = bak.cy + lxOpp * si + lyOpp * co;
               // New center is midpoint of cursor and opposite corner.
               var newCx = (p.x + oppX) / 2;
               var newCy = (p.y + oppY) / 2;
               // Vector from new center to cursor, transformed to local.
               var vx = p.x - newCx, vy = p.y - newCy;
               var ico = Math.cos( -bak.angle ), isi = Math.sin( -bak.angle );
               var lx = vx * ico - vy * isi;
               var ly = vx * isi + vy * ico;
               s.cx    = newCx;
               s.cy    = newCy;
               s.rx    = Math.max( 1, Math.abs( lx ) );
               s.ry    = Math.max( 1, Math.abs( ly ) );
               s.angle = bak.angle;
            }
            scheduleUpdate();
         }
      }

      // Hover cursor feedback when not actively dragging.
      if ( self._dragMode == null )
      {
         if ( data.maskTool === "pan" )
            self._setCursorId( StdCursor_OpenHand );
         else if ( data.maskTool === "brush" || data.maskTool === "eraser" )
            self._setCursorId( StdCursor_Cross );
         else
         {
            var hover = self._hitActiveShape( x, y );
            self._setCursorId( self._modeToCursor( hover ) );
         }
      }

      if ( data.maskTool !== "pan" )
         self.repaint();
   };

   this.onMouseRelease = function( x, y, button, buttons, modifiers )
   {
      if ( self._dragMode === "pan" )
      {
         self._dragMode = null;
         self._panning  = false;
         self.cursor    = new Cursor( StdCursor_OpenHand );
         return;
      }
      // Rebuild both overlays + clear the trail whenever a stroke
      // was actually in progress, even if the user switched tool
      // mid-drag via the combo box.
      if ( self._brushTrail.length > 0
        || data.maskTool === "brush" || data.maskTool === "eraser" )
      {
         // Final paint at the release position, in case the brush
         // throttle skipped the last few mouse-move events.
         if ( self._brushTrail.length > 0 && self.bitmap != null
           && (data.maskTool === "brush" || data.maskTool === "eraser") )
         {
            var last = self._brushTrail[ self._brushTrail.length - 1 ];
            var lr   = pctToPx( data.brushRadiusPct, self.bitmap.width );
            var lf   = pctToPx( data.maskFeatherPct, self.bitmap.width );
            if ( data.maskTool === "brush" )
               paintCircleToPending( last.x, last.y, lr, lf );
            else
               eraseCircleFromMasks( last.x, last.y, lr, lf );
         }
         rebuildMaskOverlay();
         rebuildPendingOverlay();
         self._brushTrail = [];
      }
      // If the user just clicked (no real drag) on an empty area with
      // the geometric tools, discard the tiny placeholder shape so a
      // 1-pixel "ghost" doesn't haunt the canvas.
      if ( self._dragMode === "draw" && data.activeShape != null
        && data.activeShape.rx < 3 && data.activeShape.ry < 3 )
      {
         discardActiveShape();
      }
      self._dragMode     = null;
      self._dragShapeBak = null;
      // Refresh commit-button state: a brush stroke may have made
      // the pending mask non-empty, enabling Apply Edits.
      updateCommitButton();
      scheduleUpdate();
      self.repaint();
   };

   // Switch the cursor whenever the tool changes externally (combo box).
   this.refreshCursor = function()
   {
      self._lastCursorId = -999;
      if ( data.maskTool === "pan" )
         self._setCursorId( StdCursor_OpenHand );
      else
         self._setCursorId( StdCursor_Cross );
   };

   this.onResize = function()
   {
      scheduleResize();
   };
}
PreviewFrame.prototype = new Frame;

// ===================== Dialog =====================

function CombinerDialog()
{
   this.__base__ = Dialog;
   this.__base__();

   ui = this;
   var self = this;
   // Width of the longest label + a small padding so all colons line up.
   var labelWidth = this.font.width( "Remove Green via SCNR:" ) + 4;

   this.windowTitle   = TITLE + " v" + VERSION;
   this.userResizable = true;

   // ---- Starless ViewCombo ----
   var slLabel = new Label( this );
   slLabel.text          = "Starless:";
   slLabel.setFixedWidth( labelWidth );
   slLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.starlessViewList = new ViewCombo( this );
   this.starlessViewList.onViewSelected = function( view )
   {
      data.starlessView = view;
      closeWindowById( ID_STP_SMALL );
      closeWindowById( ID_PV_SMALL );
      // Discard any mask state - its coordinates were referred to the
      // PREVIOUS view's cache, which would be meaningless against a
      // new starless of potentially different size.
      discardActiveShape();
      closeWindowById( ID_MASK );
      data.maskOverlayBitmap = null;
      if ( view == null || view.isNull )
      {
         closeWindowById( ID_SL_SMALL );
         data.starlessSmall = null;
      }
      else
      {
         __cacheSize = computeCacheMaxSize();
         data.starlessSmall = buildSmall( view, ID_SL_SMALL, __cacheSize );
         if ( self.previewFrame ) self.previewFrame.fitToFrame();
      }
      updateCommitButton();
      scheduleUpdate();
   };

   var slRow = new HorizontalSizer;
   slRow.spacing = 4;
   slRow.add( slLabel );
   slRow.add( this.starlessViewList, 100 );

   // ---- Stars ViewCombo + Reset ----
   var stLabel = new Label( this );
   stLabel.text          = "Stars:";
   stLabel.setFixedWidth( labelWidth );
   stLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.starsViewList = new ViewCombo( this );
   this.starsViewList.onViewSelected = function( view )
   {
      data.starsView = view;
      closeWindowById( ID_STP_SMALL );
      closeWindowById( ID_PV_SMALL );
      if ( view == null || view.isNull )
      {
         closeWindowById( ID_ST_SMALL );
         data.starsSmall = null;
      }
      else
      {
         data.starsSmall = buildSmall( view, ID_ST_SMALL, __cacheSize );
      }
      scheduleUpdate();
   };

   // Validate that starless and stars have matching channel counts.
   // Mixed (one color, one grayscale) produces silent PixelMath errors
   // in the combine. Warn the user but allow them to continue.
   function validateChannels()
   {
      if ( data.starlessView == null || data.starlessView.isNull ) return;
      if ( data.starsView    == null || data.starsView.isNull )    return;
      var slC = data.starlessView.image.numberOfChannels;
      var stC = data.starsView.image.numberOfChannels;
      if ( (slC > 1) !== (stC > 1) )
      {
         console.warningln( "* WARNING: starless has " + slC +
                            " channel(s), stars has " + stC +
                            ". Mixing color and grayscale may produce " +
                            "unexpected results." );
      }
   }
   this.starlessViewList.onViewSelected = (function( orig ) {
      return function( view ) { orig( view ); validateChannels(); };
   })( this.starlessViewList.onViewSelected );
   this.starsViewList.onViewSelected = (function( orig ) {
      return function( view ) { orig( view ); validateChannels(); };
   })( this.starsViewList.onViewSelected );

   this.resetBtn = new PushButton( this );
   this.resetBtn.text    = "Reset";
   this.resetBtn.toolTip = "Restore AstroDL defaults (Intensity 100, Boost 1, no SCNR).";
   this.resetBtn.onClick = function()
   {
      data.stretchIntensity = STRETCH_DEF;
      data.colorBoost       = BOOST_DEF;
      data.removeGreen      = false;
      data.removeMagenta    = false;
      self.stretchNC.setValue( data.stretchIntensity );
      self.boostNC.setValue( data.colorBoost );
      self.scnrCheck.checked         = data.removeGreen;
      self.scnrMagentaCheck.checked  = data.removeMagenta;
      scheduleUpdate();
   };

   var stRow = new HorizontalSizer;
   stRow.spacing = 4;
   stRow.add( stLabel );
   stRow.add( this.starsViewList, 100 );
   stRow.add( this.resetBtn );

   // ---- Stretch Intensity (1..1000, linear, default 200) ----
   this.stretchNC = new NumericControl( this );
   this.stretchNC.label.text = "Stretch Intensity:";
   this.stretchNC.label.setFixedWidth( labelWidth );
   this.stretchNC.label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.stretchNC.setRange( STRETCH_MIN, STRETCH_MAX );
   this.stretchNC.slider.setRange( 0, 1000 );
   this.stretchNC.slider.scaledMinWidth = 360;
   this.stretchNC.setPrecision( 2 );
   this.stretchNC.setValue( data.stretchIntensity );
   this.stretchNC.edit.minWidth = 70;
   this.stretchNC.toolTip =
      "Stretch intensity (K) of the rational stretch:\n" +
      "    y = (K * x) / ((K - 1) * x + 1)\n" +
      "Applied per RGB channel, so bright stars keep distinct colors.\n" +
      "K = 1 means no stretch. Range 1-1000. Default 100.\n" +
      "Increase for fainter stars, decrease for sparse / bright fields.";
   this.stretchNC.onValueUpdated = function( v )
   {
      data.stretchIntensity = v;
      scheduleUpdate();
   };

   // Black Point control removed in v1.1.26: the new rational-stretch
   // formula doesn't take a blackPoint parameter the way ArcsinhStretch
   // did. The leftover block below is kept as inert dead code in case
   // we want to bring it back via a pre-clipping step in PixelMath.
   /*
   this.blackNC = new NumericControl( this );
   this.blackNC.label.text = "Black Point:";
   this.blackNC.label.setFixedWidth( labelWidth );
   this.blackNC.label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.blackNC.setRange( BLACK_MIN, BLACK_MAX );
   this.blackNC.slider.setRange( 0, 1000 );
   this.blackNC.slider.scaledMinWidth = 360;
   this.blackNC.setPrecision( 4 );
   this.blackNC.setValue( data.blackPoint );
   this.blackNC.edit.minWidth = 70;
   this.blackNC.toolTip =
      "ArcsinhStretch black point. Slightly lifts dark areas to control " +
      "the apparent sky background of the stars layer.\n" +
      "Default 0 (no clipping). Increase by a tiny amount only if needed.";
   this.blackNC.onValueUpdated = function( v )
   {
      data.blackPoint = v;
      scheduleUpdate();
   };
   */

   // ---- Star Color Boost (0..2, default 1) - multiplier for sat hat-curve ----
   this.boostNC = new NumericControl( this );
   this.boostNC.label.text = "Star Color Boost:";
   this.boostNC.label.setFixedWidth( labelWidth );
   this.boostNC.label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.boostNC.setRange( BOOST_MIN, BOOST_MAX );
   this.boostNC.slider.setRange( 0, 1000 );
   this.boostNC.slider.scaledMinWidth = 360;
   this.boostNC.setPrecision( 2 );
   this.boostNC.setValue( data.colorBoost );
   this.boostNC.edit.minWidth = 70;
   this.boostNC.toolTip =
      "Multiplier for the AstroDL saturation hat-curve:\n" +
      "[(0, b*0.50), (0.5, b*0.85), (1, b*0.50)] Akima subsplines.\n" +
      "1.0 = default boost, 0 = no boost.";
   this.boostNC.onValueUpdated = function( v )
   {
      data.colorBoost = v;
      scheduleUpdate();
   };

   // ---- SCNR row + zoom toolbar ----
   var scnrLabel = new Label( this );
   scnrLabel.text          = "Remove via SCNR:";
   scnrLabel.setFixedWidth( labelWidth );
   scnrLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.scnrCheck = new CheckBox( this );
   this.scnrCheck.text    = "Green";
   this.scnrCheck.checked = data.removeGreen;
   this.scnrCheck.toolTip = "Apply SCNR Green (AverageNeutral, preserveLightness) on " +
                            "the stretched stars. Standard for OSC astrophoto where a " +
                            "green cast remains after color calibration.";
   this.scnrCheck.onCheck = function( c )
   {
      data.removeGreen = c;
      scheduleUpdate();
   };

   this.scnrMagentaCheck = new CheckBox( this );
   this.scnrMagentaCheck.text    = "Magenta";
   this.scnrMagentaCheck.checked = data.removeMagenta;
   this.scnrMagentaCheck.toolTip = "Apply SCNR Magenta on the stretched stars. " +
                                   "Useful when SCNR Green over-corrects (or the " +
                                   "camera already pulled green) and leaves a magenta " +
                                   "cast in the stars layer.";
   this.scnrMagentaCheck.onCheck = function( c )
   {
      data.removeMagenta = c;
      scheduleUpdate();
   };

   // Per-channel checkbox removed in v1.1.26 - the new rational-stretch
   // pipeline is always per-channel by virtue of PixelMath operating
   // independently on R, G, B.

   this.zoomOutBtn = new ToolButton( this );
   this.zoomOutBtn.text    = "-";
   this.zoomOutBtn.toolTip = "Zoom out (or scroll the mouse wheel down inside the preview).";
   this.zoomOutBtn.setScaledFixedSize( 24, 24 );
   this.zoomOutBtn.onClick = function() { if ( self.previewFrame ) self.previewFrame.zoomOut(); };

   this.zoomInBtn = new ToolButton( this );
   this.zoomInBtn.text    = "+";
   this.zoomInBtn.toolTip = "Zoom in (or scroll the mouse wheel up inside the preview).";
   this.zoomInBtn.setScaledFixedSize( 24, 24 );
   this.zoomInBtn.onClick = function() { if ( self.previewFrame ) self.previewFrame.zoomIn(); };

   this.zoomFitBtn = new ToolButton( this );
   this.zoomFitBtn.text    = "Fit";
   this.zoomFitBtn.toolTip = "Reset zoom & pan: fit the whole image to the preview area.";
   this.zoomFitBtn.setScaledFixedSize( 36, 24 );
   this.zoomFitBtn.onClick = function() { if ( self.previewFrame ) self.previewFrame.fitToFrame(); };

   var zoomLabel = new Label( this );
   zoomLabel.text          = "Preview zoom:";
   zoomLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   var scnrRow = new HorizontalSizer;
   scnrRow.spacing = 4;
   scnrRow.add( scnrLabel );
   scnrRow.add( this.scnrCheck );
   scnrRow.addSpacing( 8 );
   scnrRow.add( this.scnrMagentaCheck );
   scnrRow.addStretch();
   scnrRow.add( zoomLabel );
   scnrRow.addSpacing( 4 );
   scnrRow.add( this.zoomOutBtn );
   scnrRow.add( this.zoomInBtn );
   scnrRow.add( this.zoomFitBtn );

   // ---- Save stretched stars (optional second output) ----
   var keepLabel = new Label( this );
   keepLabel.text          = "Save stretched stars:";
   keepLabel.setFixedWidth( labelWidth );
   keepLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.keepStarsCheck = new CheckBox( this );
   this.keepStarsCheck.text    = "";
   this.keepStarsCheck.checked = data.keepStars;
   this.keepStarsCheck.toolTip =
      "When enabled, Apply also creates a separate image containing only " +
      "the stretched stars (Stretch + Color Boost + optional SCNR), so " +
      "you can use it as a layer or process it further.";
   this.keepStarsCheck.onCheck = function( c )
   {
      data.keepStars = c;
      self.starsIdLabel.enabled   = c;
      self.starsOutIdEdit.enabled = c;
   };

   this.starsIdLabel = new Label( this );
   this.starsIdLabel.text          = "Name:";
   this.starsIdLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.starsIdLabel.enabled       = data.keepStars;

   this.starsOutIdEdit = new Edit( this );
   this.starsOutIdEdit.text    = data.starsOutputId;
   this.starsOutIdEdit.enabled = data.keepStars;
   this.starsOutIdEdit.setFixedWidth( this.font.width( "WWWWWWWWWWWWWWWWWW" ) );
   this.starsOutIdEdit.toolTip =
      "ID for the stretched-stars image created by Apply when the " +
      "checkbox is enabled. A numeric suffix is appended if the ID " +
      "already exists.";
   this.starsOutIdEdit.onEditCompleted = function()
   {
      data.starsOutputId = this.text.length > 0 ? this.text : "Stars_Stretched";
   };

   var keepRow = new HorizontalSizer;
   keepRow.spacing = 4;
   keepRow.add( keepLabel );
   keepRow.add( this.keepStarsCheck );
   keepRow.addSpacing( 12 );
   keepRow.add( this.starsIdLabel );
   keepRow.addSpacing( 4 );
   keepRow.add( this.starsOutIdEdit );
   keepRow.addStretch();

   // ===================== Mask toolbar =====================

   // Row 1: tool combo + invert check + clear button
   var maskToolLabel = new Label( this );
   maskToolLabel.text          = "Mask Tool:";
   maskToolLabel.setFixedWidth( labelWidth );
   maskToolLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.maskToolCombo = new ComboBox( this );
   this.maskToolCombo.editEnabled = false;
   this.maskToolCombo.addItem( "Off / Pan view" );                  // 0
   this.maskToolCombo.addItem( "Ellipse (drag to draw oriented)" ); // 1
   this.maskToolCombo.addItem( "Rectangle (drag to draw)" );        // 2
   // NOTE: Brush and Eraser tools are temporarily hidden from the UI
   // pending stability work (see GitHub issues). Internal support
   // remains in the code.
   this.maskToolCombo.currentItem = 0;
   this.maskToolCombo.toolTip =
      "Select a drawing tool. The mask reduces the contribution of the " +
      "stars layer in painted areas, so gas / nebulosity from the " +
      "starless shows through more clearly.\n" +
      "Ellipse: first click + drag = ends of the major axis (auto-rotated).\n" +
      "Rectangle: drag from one corner to the opposite corner.";
   this.maskToolCombo.onItemSelected = function( idx )
   {
      var newTool = ["pan","ellipse","rect"][ idx ] || "pan";
      // When switching AWAY from an editable-shape tool, auto-commit
      // any active shape so the user doesn't lose work.
      if ( newTool !== data.maskTool && data.activeShape != null )
      {
         commitActiveShape();
         rebuildMaskOverlay();
      }
      data.maskTool = newTool;
      updateMaskRowsVisibility();
      updateCommitButton();
      if ( self.previewFrame )
      {
         self.previewFrame.refreshCursor();
         self.previewFrame.repaint();
      }
      scheduleUpdate();
   };

   this.maskCommitBtn = new PushButton( this );
   this.maskCommitBtn.text    = "Apply Edits";
   this.maskCommitBtn.enabled = false;
   this.maskCommitBtn.toolTip =
      "Bake the current editable shape AND all pending brush strokes " +
      "into the persistent mask, then clear them. Pending edits show " +
      "in pink/cyan; committed mask shows in red.\n" +
      "Shortcuts: ENTER = commit, ESC = discard shape, " +
      "SHIFT+ESC = discard pending brush, DEL = clear all.";
   this.maskCommitBtn.onClick = function()
   {
      if ( !hasPendingEdits() ) return;
      commitAllPending();
      updateCommitButton();
      if ( self.previewFrame ) self.previewFrame.repaint();
      scheduleUpdate();
   };

   this.maskInvertCheck = new CheckBox( this );
   this.maskInvertCheck.text    = "Invert";
   this.maskInvertCheck.checked = data.maskInvert;
   this.maskInvertCheck.toolTip =
      "When checked, the mask KEEPS stars only inside the painted area " +
      "and removes them everywhere else - useful to keep stars only on " +
      "a specific region (e.g. a galaxy core) and remove them around " +
      "it. The active shape and brush ring show cyan in invert mode.";
   this.maskInvertCheck.onCheck = function( c )
   {
      data.maskInvert = c;
      scheduleUpdate();
      if ( self.previewFrame ) self.previewFrame.repaint();
   };

   // 3-mode view selector for the preview canvas.
   this.viewModeCombo = new ComboBox( this );
   this.viewModeCombo.editEnabled = false;
   this.viewModeCombo.addItem( "Image only (mask effect OFF)" );  // 0 = edit
   this.viewModeCombo.addItem( "Image + mask effect (preview Apply)" );  // 1 = result
   this.viewModeCombo.addItem( "Mask only (B/W)" );               // 2 = mask
   this.viewModeCombo.currentItem =
        (data.viewMode === "result") ? 1
      : (data.viewMode === "mask"  ) ? 2 : 0;
   this.viewModeCombo.toolTip =
      "Edit (default): full image with mask shown as overlay/outline. " +
      "The mask is NOT applied to the combine so the underlying image " +
      "stays visible - best for aligning shapes to features.\n" +
      "Result: the mask IS applied to the combine, so you see exactly " +
      "what the Apply button will produce.\n" +
      "Mask only: shows the mask itself in black and white. Useful to " +
      "verify the gradient profile and intensity.\n" +
      "Apply always uses the mask regardless of the view mode.";
   this.viewModeCombo.onItemSelected = function( idx )
   {
      data.viewMode = ["edit","result","mask"][ idx ];
      scheduleUpdate();
      if ( self.previewFrame ) self.previewFrame.repaint();
   };

   this.maskClearBtn = new PushButton( this );
   this.maskClearBtn.text    = "Clear Mask";
   this.maskClearBtn.toolTip = "Reset the mask and discard the editable shape: " +
                               "stars are restored everywhere. Shortcut: DEL.";
   this.maskClearBtn.onClick = function()
   {
      discardActiveShape();
      clearMask();
      clearMaskPending();
      updateCommitButton();
      if ( self.previewFrame )
         self.previewFrame.repaint();
      scheduleUpdate();
   };

   var maskToolRow = new HorizontalSizer;
   maskToolRow.spacing = 4;
   maskToolRow.add( maskToolLabel );
   maskToolRow.add( this.maskToolCombo, 100 );
   maskToolRow.add( this.maskInvertCheck );
   maskToolRow.add( this.maskCommitBtn );
   maskToolRow.add( this.maskClearBtn );

   // Quick "Compare" button: toggle Edit <-> Result so the user can
   // flip between with/without mask effect with a single click.
   this.compareBtn = new PushButton( this );
   this.compareBtn.text    = "Compare";
   this.compareBtn.toolTip =
      "Quickly toggle between 'Image only' and 'Image + mask effect' " +
      "to compare the before / after of the mask. Same as switching " +
      "the Preview View combo between options 1 and 2.\n" +
      "Shortcut: M.";
   this.compareBtn.onClick = function()
   {
      if ( data.viewMode === "edit" )
      {
         data.viewMode = "result";
         self.viewModeCombo.currentItem = 1;
      }
      else
      {
         data.viewMode = "edit";
         self.viewModeCombo.currentItem = 0;
      }
      scheduleUpdate();
      if ( self.previewFrame ) self.previewFrame.repaint();
   };

   // "Smooth" button: Gaussian blur of the mask (committed AND pending)
   // to soften hard brush edges or shape boundaries. Each click adds
   // more smoothing - run twice for stronger blur.
   this.maskSmoothBtn = new PushButton( this );
   this.maskSmoothBtn.text    = "Smooth";
   this.maskSmoothBtn.toolTip =
      "Apply a Gaussian blur (0.5% of image width) to the mask to " +
      "soften hard brush edges or sharp shape boundaries. Useful after " +
      "painting freehand strokes. Click again for stronger smoothing.";
   this.maskSmoothBtn.onClick = function()
   {
      smoothMaskWindows( 0.5 );
      rebuildMaskOverlay();
      rebuildPendingOverlay();
      updateCommitButton();
      if ( self.previewFrame ) self.previewFrame.repaint();
      scheduleUpdate();
   };

   // A second row for the view-mode selector. Kept separate from the
   // mask tool row so the tool row stays compact.
   var viewModeRow = new HorizontalSizer;
   viewModeRow.spacing = 4;
   var viewModeLabelFixed = new Label( this );
   viewModeLabelFixed.text          = "Preview View:";
   viewModeLabelFixed.setFixedWidth( labelWidth );
   viewModeLabelFixed.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   viewModeRow.add( viewModeLabelFixed );
   viewModeRow.add( this.viewModeCombo, 100 );
   viewModeRow.add( this.compareBtn );
   // viewModeRow.add( this.maskSmoothBtn );  // Hidden: brush is disabled.

   // Row 2: Mask Strength slider
   this.maskStrengthNC = new NumericControl( this );
   this.maskStrengthNC.label.text          = "Mask Strength:";
   this.maskStrengthNC.label.setFixedWidth( labelWidth );
   this.maskStrengthNC.label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.maskStrengthNC.setRange( 0.0, 1.0 );
   this.maskStrengthNC.slider.setRange( 0, 1000 );
   this.maskStrengthNC.slider.scaledMinWidth = 360;
   this.maskStrengthNC.setPrecision( 2 );
   this.maskStrengthNC.setValue( data.maskStrength );
   this.maskStrengthNC.edit.minWidth = 70;
   this.maskStrengthNC.toolTip =
      "How strongly the mask attenuates the stars in painted areas.\n" +
      "0 = mask disabled, 1 = stars fully removed where painted.";
   this.maskStrengthNC.onValueUpdated = function( v )
   {
      data.maskStrength = v;
      scheduleUpdate();
   };

   // Row 3: Feather and Brush radius (both as % of image width)
   this.maskFeatherNC = new NumericControl( this );
   this.maskFeatherNC.label.text          = "Mask Feather:";
   this.maskFeatherNC.label.setFixedWidth( labelWidth );
   this.maskFeatherNC.label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.maskFeatherNC.setRange( 0.0, 20.0 );
   this.maskFeatherNC.slider.setRange( 0, 1000 );
   this.maskFeatherNC.slider.scaledMinWidth = 360;
   this.maskFeatherNC.setPrecision( 2 );
   this.maskFeatherNC.setValue( data.maskFeatherPct );
   this.maskFeatherNC.edit.minWidth = 70;
   this.maskFeatherNC.toolTip =
      "Soft edge width of the mask, as a percentage of the image width.\n" +
      "Applied when a new shape is painted. Existing shapes keep the " +
      "feather they had at paint time.";
   this.maskFeatherNC.onValueUpdated = function( v )
   {
      data.maskFeatherPct = v;
      // Live-update the active shape so the user sees the new feather
      // immediately, without having to redraw the shape. Existing
      // committed (raster-baked) shapes keep the feather they had at
      // paint time and are not affected.
      if ( data.activeShape != null && data.starlessSmall != null )
      {
         var bw = data.starlessSmall.mainView.image.width;
         data.activeShape.feather = pctToPx( v, bw );
         scheduleUpdate();
      }
      if ( self.previewFrame ) self.previewFrame.repaint();
   };

   this.brushRadiusNC = new NumericControl( this );
   this.brushRadiusNC.label.text          = "Brush Radius:";
   this.brushRadiusNC.label.setFixedWidth( labelWidth );
   this.brushRadiusNC.label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.brushRadiusNC.setRange( 0.5, 25.0 );
   this.brushRadiusNC.slider.setRange( 0, 1000 );
   this.brushRadiusNC.slider.scaledMinWidth = 360;
   this.brushRadiusNC.setPrecision( 2 );
   this.brushRadiusNC.setValue( data.brushRadiusPct );
   this.brushRadiusNC.edit.minWidth = 70;
   this.brushRadiusNC.toolTip =
      "Radius of the brush stroke, as a percentage of the image width.\n" +
      "Only used by the Brush tool.";
   this.brushRadiusNC.onValueUpdated = function( v )
   {
      data.brushRadiusPct = v;
      if ( self.previewFrame )
         self.previewFrame.repaint();
   };

   // Gradient Center slider: where inside the shape the falloff starts,
   // expressed as a percentage (0..100). 100% = solid until boundary
   // (default), 0% = pure radial gradient from the center.
   this.gradientCtrNC = new NumericControl( this );
   this.gradientCtrNC.label.text          = "Gradient Center:";
   this.gradientCtrNC.label.setFixedWidth( labelWidth );
   this.gradientCtrNC.label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.gradientCtrNC.setRange( 0.0, 100.0 );
   this.gradientCtrNC.slider.setRange( 0, 1000 );
   this.gradientCtrNC.slider.scaledMinWidth = 360;
   this.gradientCtrNC.setPrecision( 0 );
   this.gradientCtrNC.setValue( data.maskGradientCtr * 100.0 );
   this.gradientCtrNC.edit.minWidth = 70;
   this.gradientCtrNC.toolTip =
      "Where inside the shape the gradient starts, as a percentage of " +
      "the shape's radius.\n" +
      "100% = solid mask=1 until the boundary, then falloff outside " +
      "over Feather pixels (default).\n" +
      "0% = gradient from the center, no solid zone.\n" +
      "50% = solid until half radius, gradient from there outward.\n" +
      "Verify the result by switching the Preview View to 'Mask only (B/W)'.";
   this.gradientCtrNC.onValueUpdated = function( v )
   {
      var frac = v / 100.0;
      data.maskGradientCtr = frac;
      // Live-update the active shape so the change is visible.
      if ( data.activeShape != null )
         data.activeShape.gradientCenter = frac;
      scheduleUpdate();
   };

   // ---- Embedded preview ----
   this.previewFrame = new PreviewFrame( this );

   // ---- Bottom row ----
   var outLabel = new Label( this );
   outLabel.text          = "Output name:";
   outLabel.setFixedWidth( labelWidth );
   outLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.outIdEdit = new Edit( this );
   this.outIdEdit.text = data.outputId;
   this.outIdEdit.setFixedWidth( this.font.width( "WWWWWWWWWWWWWWWWWW" ) );
   this.outIdEdit.toolTip = "ID of the final combined image created by Apply.";
   this.outIdEdit.onEditCompleted = function()
   {
      if ( this.text.length === 0 ) this.text = "Combined";
      data.outputId = this.text;
   };

   this.applyBtn = new PushButton( this );
   this.applyBtn.text    = "Apply";
   this.applyBtn.toolTip = "Generate the final combined image at full resolution.";
   this.applyBtn.onClick = function() { applyFinal(); };

   this.closeBtn = new PushButton( this );
   this.closeBtn.text    = "Close";
   this.closeBtn.onClick = function() { self.ok(); };

   this.newInstanceBtn = new ToolButton( this );
   this.newInstanceBtn.icon = this.scaledResource( ":/process-interface/new-instance.png" );
   this.newInstanceBtn.setScaledFixedSize( 24, 24 );
   this.newInstanceBtn.toolTip =
      "Drag this triangle to the workspace to save the current settings " +
      "as a process icon. Double-click the icon later to relaunch the " +
      "dialog with these values.";
   this.newInstanceBtn.onMousePress = function()
   {
      data.save();
      self.newInstance();
   };

   var btmRow = new HorizontalSizer;
   btmRow.spacing = 6;
   btmRow.add( this.newInstanceBtn );
   btmRow.addSpacing( 8 );
   btmRow.add( outLabel );
   btmRow.add( this.outIdEdit );
   btmRow.addStretch();
   btmRow.add( this.applyBtn );
   btmRow.add( this.closeBtn );

   // Credits line (brand visibility).
   this.creditLabel = new Label( this );
   this.creditLabel.text = BRAND + " - " + TOOL + " v" + VERSION + " - by Luis Jose DL - MIT License";
   this.creditLabel.textAlignment = TextAlign_Center | TextAlign_VertCenter;
   this.creditLabel.styleSheet = "QLabel { color: gray; font-size: 8pt; }";
   this.creditLabel.toolTip =
      "AstroDL is luisjosedl's astrophotography tool suite for PixInsight. " +
      "This script uses PixInsight's native ArcsinhStretch as its stretch " +
      "engine. MIT License.";

   // ---- Layout ----
   this.sizer = new VerticalSizer;
   this.sizer.margin  = 8;
   this.sizer.spacing = 6;
   this.sizer.add( slRow );
   this.sizer.add( stRow );
   this.sizer.add( this.stretchNC );
   // this.sizer.add( this.blackNC );    // removed in v1.1.26
   this.sizer.add( this.boostNC );
   this.sizer.add( scnrRow );
   this.sizer.add( keepRow );
   this.sizer.add( maskToolRow );
   this.sizer.add( viewModeRow );
   this.sizer.add( this.maskStrengthNC );
   this.sizer.add( this.maskFeatherNC );
   this.sizer.add( this.gradientCtrNC );
   // this.sizer.add( this.brushRadiusNC );  // Hidden: brush is disabled.
   this.sizer.add( this.previewFrame, 100 );
   this.sizer.add( btmRow );
   this.sizer.add( this.creditLabel );

   // Keyboard shortcuts for mask editing:
   //   ESC    : discard the active shape (silently, without committing)
   //   ENTER  : commit the active shape (same as Commit Shape button)
   //   DELETE : clear the entire mask (same as Clear Mask button)
   this.onKeyPress = function( keyCode, modifiers )
   {
      var handled = false;
      var shiftDown = !!(modifiers & KeyModifier_Shift);
      if ( keyCode === Key_Escape )
      {
         if ( shiftDown && pendingMaskIsActive() )
         {
            // SHIFT+ESC: discard pending brush strokes only.
            clearMaskPending();
            updateCommitButton();
            if ( self.previewFrame ) self.previewFrame.repaint();
            scheduleUpdate();
            handled = true;
         }
         else if ( data.activeShape != null )
         {
            discardActiveShape();
            updateCommitButton();
            if ( self.previewFrame ) self.previewFrame.repaint();
            scheduleUpdate();
            handled = true;
         }
      }
      else if ( keyCode === Key_Return || keyCode === Key_Enter )
      {
         if ( hasPendingEdits() )
         {
            commitAllPending();
            updateCommitButton();
            if ( self.previewFrame ) self.previewFrame.repaint();
            scheduleUpdate();
            handled = true;
         }
      }
      else if ( keyCode === Key_Delete )
      {
         discardActiveShape();
         clearMask();
         clearMaskPending();
         updateCommitButton();
         if ( self.previewFrame ) self.previewFrame.repaint();
         scheduleUpdate();
         handled = true;
      }
      else if ( keyCode === Key_M )
      {
         // Toggle Edit <-> Result modes (quick before/after comparison).
         if ( data.viewMode === "edit" )
         {
            data.viewMode = "result";
            self.viewModeCombo.currentItem = 1;
         }
         else if ( data.viewMode === "result" )
         {
            data.viewMode = "edit";
            self.viewModeCombo.currentItem = 0;
         }
         scheduleUpdate();
         if ( self.previewFrame ) self.previewFrame.repaint();
         handled = true;
      }
      return handled;
   };

   // Apply initial visibility / button state to match the default tool.
   updateMaskRowsVisibility();
   updateCommitButton();

   this.adjustToContents();
   this.setMinSize( 680, 900 );

   // ---- Preselect by name ----
   (function preselect()
   {
      var windows = ImageWindow.windows;
      for ( var i = 0; i < windows.length; ++i )
      {
         var v  = windows[i].mainView;
         var id = v.id.toLowerCase();
         if ( data.starlessView == null && /(starless|nostars|no_stars)/.test( id ) )
         {
            data.starlessView  = v;
            self.starlessViewList.currentView = v;
            data.starlessSmall = buildSmall( v, ID_SL_SMALL, __cacheSize );
         }
         else if ( data.starsView == null && /(stars$|^stars|star_mask|star-mask|onlystars)/.test( id ) )
         {
            data.starsView  = v;
            self.starsViewList.currentView = v;
            data.starsSmall = buildSmall( v, ID_ST_SMALL, __cacheSize );
         }
      }
      scheduleUpdate();
   })();
}
CombinerDialog.prototype = new Dialog;

// ===================== main =====================

function main()
{
   console.hide();
   cleanup();
   data.load();
   var dlg = new CombinerDialog();
   dlg.execute();
   cleanup();
}

main();
