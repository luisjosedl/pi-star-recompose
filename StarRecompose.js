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

#define BRAND         "AstroDL"
#define TOOL          "Star Recompose"
#define TITLE         "AstroDL - Star Recompose"
#define VERSION       "1.1.11"

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
#define ID_MASK       "__AD_mask"
#define ID_MASK_FULL  "__AD_mask_full"
#define ID_OVERLAY    "__AD_overlay"

// Mask defaults. Strength: 0..1, how much the mask attenuates the
// stars. Feather/Brush radii are expressed as a percentage of the
// image width so the visual size is resolution-independent.
#define MASK_STRENGTH_DEF   1.0
#define MASK_FEATHER_DEF    2.0      // percent of image width
#define BRUSH_RADIUS_DEF    5.0      // percent of image width

// Slider ranges. STRETCH maps DIRECTLY to ArcsinhStretch.stretch (no
// hidden formula). BLACK_POINT maps to ArcsinhStretch.blackPoint.
// BOOST is a multiplier for our own ColorSaturation hat-curve.
#define STRETCH_MIN   1.0
#define STRETCH_MAX   1000.0
#define STRETCH_DEF   200.0

#define BLACK_MIN     0.0
#define BLACK_MAX     0.05
#define BLACK_DEF     0.0

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
   this.blackPoint       = BLACK_DEF;
   this.colorBoost       = BOOST_DEF;
   this.removeGreen      = false;
   this.outputId         = "Combined";
   this.keepStars        = false;
   this.starsOutputId    = "Stars_Stretched";

   // Mask state (session-only, not persisted in the script instance).
   this.maskTool         = "pan";    // "pan" | "ellipse" | "rect" | "brush"
   this.maskStrength     = MASK_STRENGTH_DEF;
   this.maskFeatherPct   = MASK_FEATHER_DEF;
   this.brushRadiusPct   = BRUSH_RADIUS_DEF;
   this.maskInvert       = false;
   this.maskOverlayBitmap = null;     // cached visualization bitmap

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
      Parameters.set( "stretchIntensity", this.stretchIntensity );
      Parameters.set( "blackPoint",       this.blackPoint );
      Parameters.set( "colorBoost",       this.colorBoost );
      Parameters.set( "removeGreen",      this.removeGreen );
      Parameters.set( "outputId",         this.outputId );
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
      if ( Parameters.has( "blackPoint" ) )
         this.blackPoint = Parameters.getReal( "blackPoint" );
      if ( Parameters.has( "colorBoost" ) )
         this.colorBoost = Parameters.getReal( "colorBoost" );
      if ( Parameters.has( "removeGreen" ) )
         this.removeGreen = Parameters.getBoolean( "removeGreen" );
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

// 2. ArcsinhStretch (PixInsight native, based on Lupton et al. 1999):
//    y = asinh(stretch * x) / asinh(stretch)
//    With useRgbws=true and protectHighlights=true so star colors are
//    preserved instead of being clipped to white. The UI intensity is
//    passed directly to ArcsinhStretch.stretch with no scaling.
function applyArcsinh( view, intensity, blackPoint )
{
   var AS = new ArcsinhStretch;
   AS.stretch              = intensity;
   AS.blackPoint           = blackPoint;
   AS.protectHighlights    = true;
   AS.useRgbws             = true;
   AS.executeOn( view, false );
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

// 4. SCNR Green - native PI process (Russell Croman).
function applySCNR( view )
{
   var P = new SCNR;
   P.amount             = 1.00;
   P.protectionMethod   = SCNR.prototype.AverageNeutral;
   P.colorToRemove      = SCNR.prototype.Green;
   P.preserveLightness  = true;
   P.executeOn( view, false );
}

// Build the "effective mask" sub-expression, combining the raster
// mask (if it exists) with the active shape's inline expression
// (if there is one) via max(). Returns null if neither contributes.
function buildEffectiveMaskExpr( maskId, activeExpr )
{
   if ( maskId == null && activeExpr == null ) return null;
   if ( maskId == null ) return activeExpr;
   if ( activeExpr == null ) return maskId;
   return "max(" + maskId + "," + activeExpr + ")";
}

// 5. Combine:  destView = min(1, starless + starsProcessed * weight)
//    where weight = 1                       (no mask)
//                 = (1 - mask * strength)   (normal mask: hide stars where painted)
//                 = (1 - (1 - mask) * strength)  (inverted mask: keep stars only
//                                                  where painted)
function applyCombineWithMask( starlessId, starsProcId, maskId, activeExpr,
                               strength, invert, destView )
{
   var effective = buildEffectiveMaskExpr( maskId, activeExpr );

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

// Paint a feathered ellipse into the mask at IMAGE coordinates.
// (cx, cy): center in pixels.  rx, ry: radii in pixels.
// feather: gradient transition width in pixels (outside the rim).
function paintEllipseToMask( cx, cy, rx, ry, feather )
{
   var w = ensureMaskWindow();
   if ( w == null ) return;
   rx = Math.max( 0.5, rx );
   ry = Math.max( 0.5, ry );
   var f = Math.max( 0.5, feather );
   var fnorm = f / Math.min( rx, ry );

   var axTerm = "((x()-(" + cx.toFixed( 2 ) + "))/" + rx.toFixed( 4 ) + ")";
   var ayTerm = "((y()-(" + cy.toFixed( 2 ) + "))/" + ry.toFixed( 4 ) + ")";
   var dist   = "sqrt(" + axTerm + "*" + axTerm + "+" + ayTerm + "*" + ayTerm + ")";
   var value  = "max(0,min(1,1-(" + dist + "-1)/" + fnorm.toFixed( 4 ) + "))";

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
   pm.executeOn( w.mainView, false );
}

// Paint a feathered axis-aligned rectangle into the mask.
// Inside the rectangle the value is 1; outside it falls off linearly
// to 0 over `feather` pixels measured perpendicular to the edges.
function paintRectToMask( x1, y1, x2, y2, feather )
{
   var w = ensureMaskWindow();
   if ( w == null ) return;
   if ( x1 > x2 ) { var tx = x1; x1 = x2; x2 = tx; }
   if ( y1 > y2 ) { var ty = y1; y1 = y2; y2 = ty; }
   var f = Math.max( 0.5, feather );

   var dx = "max(0,max(" + x1.toFixed( 2 ) + "-x(),x()-" + x2.toFixed( 2 ) + "))";
   var dy = "max(0,max(" + y1.toFixed( 2 ) + "-y(),y()-" + y2.toFixed( 2 ) + "))";
   var dist  = "sqrt(" + dx + "*" + dx + "+" + dy + "*" + dy + ")";
   var value = "max(0,min(1,1-" + dist + "/" + f.toFixed( 4 ) + "))";

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
   pm.executeOn( w.mainView, false );
}

// Paint a feathered circle (brush stroke) into the mask. Equivalent
// to paintEllipseToMask with rx = ry.
function paintCircleToMask( cx, cy, radius, feather )
{
   paintEllipseToMask( cx, cy, radius, radius, feather );
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
      pm.expression0          = ID_MASK;
      pm.expression1          = "0";
      pm.expression2          = "0";
      pm.createNewImage       = true;
      pm.newImageId           = ID_OVERLAY;
      pm.newImageColorSpace   = 1;          // RGB
      pm.newImageSampleFormat = 3;          // 32-bit float
      pm.showNewImage         = false;
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

// ===================== Active shape =====================

// Build a PixelMath sub-expression (no surrounding "min(1,...)" or
// strength) that evaluates to the feathered mask of the active shape,
// 1 deep inside, falling off to 0 over `feather` pixels outside.
// Returns null when there is no active shape or the cache is missing.
function activeShapeMaskExpr()
{
   if ( data.activeShape == null ) return null;
   if ( data.starlessSmall == null ) return null;

   var s = data.activeShape;
   var rx = Math.max( 0.5, s.rx );
   var ry = Math.max( 0.5, s.ry );
   var f  = Math.max( 0.5, s.feather );
   var cx = s.cx.toFixed( 2 );
   var cy = s.cy.toFixed( 2 );

   // Rotated coordinates in shape's local frame:
   //   lx =  (x-cx)*cos(a) + (y-cy)*sin(a)
   //   ly = -(x-cx)*sin(a) + (y-cy)*cos(a)
   var co = Math.cos( s.angle ).toFixed( 6 );
   var si = Math.sin( s.angle ).toFixed( 6 );
   var lxExpr = "((x()-" + cx + ")*" + co + "+(y()-" + cy + ")*" + si + ")";
   var lyExpr = "(-(x()-" + cx + ")*" + si + "+(y()-" + cy + ")*" + co + ")";

   if ( s.type === "ellipse" )
   {
      var fnorm = (f / Math.min( rx, ry )).toFixed( 4 );
      var ax = "(" + lxExpr + "/" + rx.toFixed( 4 ) + ")";
      var ay = "(" + lyExpr + "/" + ry.toFixed( 4 ) + ")";
      var dist = "sqrt(" + ax + "*" + ax + "+" + ay + "*" + ay + ")";
      return "max(0,min(1,1-(" + dist + "-1)/" + fnorm + "))";
   }
   else if ( s.type === "rect" )
   {
      // Distance from the rectangle's edge in local coords.
      var dx = "max(0,abs(" + lxExpr + ")-" + rx.toFixed( 2 ) + ")";
      var dy = "max(0,abs(" + lyExpr + ")-" + ry.toFixed( 2 ) + ")";
      var dist = "sqrt(" + dx + "*" + dx + "+" + dy + "*" + dy + ")";
      return "max(0,min(1,1-" + dist + "/" + f.toFixed( 4 ) + "))";
   }
   return null;
}

// Bake the active shape into the persistent raster mask and clear it.
// Called from "Commit Shape" button and when the user switches tools.
function commitActiveShape()
{
   if ( data.activeShape == null ) return;
   var s = data.activeShape;
   data.activeShape = null;       // clear FIRST so the painter doesn't pick it up
   var w = ensureMaskWindow();
   if ( w == null ) return;

   // Use the same expression we used inline, but apply it to the mask
   // window with a max() blend so it accumulates with existing content.
   var rx = Math.max( 0.5, s.rx );
   var ry = Math.max( 0.5, s.ry );
   var f  = Math.max( 0.5, s.feather );
   var cx = s.cx.toFixed( 2 );
   var cy = s.cy.toFixed( 2 );
   var co = Math.cos( s.angle ).toFixed( 6 );
   var si = Math.sin( s.angle ).toFixed( 6 );
   var lxExpr = "((x()-" + cx + ")*" + co + "+(y()-" + cy + ")*" + si + ")";
   var lyExpr = "(-(x()-" + cx + ")*" + si + "+(y()-" + cy + ")*" + co + ")";

   var value;
   if ( s.type === "ellipse" )
   {
      var fnorm = (f / Math.min( rx, ry )).toFixed( 4 );
      var ax = "(" + lxExpr + "/" + rx.toFixed( 4 ) + ")";
      var ay = "(" + lyExpr + "/" + ry.toFixed( 4 ) + ")";
      var dist = "sqrt(" + ax + "*" + ax + "+" + ay + "*" + ay + ")";
      value = "max(0,min(1,1-(" + dist + "-1)/" + fnorm + "))";
   }
   else
   {
      var dx = "max(0,abs(" + lxExpr + ")-" + rx.toFixed( 2 ) + ")";
      var dy = "max(0,abs(" + lyExpr + ")-" + ry.toFixed( 2 ) + ")";
      var dist2 = "sqrt(" + dx + "*" + dx + "+" + dy + "*" + dy + ")";
      value = "max(0,min(1,1-" + dist2 + "/" + f.toFixed( 4 ) + "))";
   }

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

// Run the full pipeline:
// copy stars -> arcsinh -> (sat + scnr) -> combine (with optional mask).
function runPipeline( starlessId, starsSrcId, procView, targetView, isColor )
{
   copyInto( starsSrcId, procView );
   applyArcsinh( procView, data.stretchIntensity, data.blackPoint );
   if ( isColor )
   {
      applyColorSat( procView, data.colorBoost );
      if ( data.removeGreen )
         applySCNR( procView );
   }
   var maskId    = (maskIsActive() && data.maskStrength > 0) ? ID_MASK : null;
   var activeExp = (data.activeShape != null && data.maskStrength > 0)
                 ? activeShapeMaskExpr() : null;
   applyCombineWithMask( starlessId, procView.id, maskId, activeExp,
                         data.maskStrength, data.maskInvert, targetView );
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

      var isColor = data.starlessSmall.mainView.image.numberOfChannels > 1
                 && data.starsSmall.mainView.image.numberOfChannels   > 1;

      runPipeline(
         ID_SL_SMALL,
         ID_ST_SMALL,
         data.starsProc.mainView,
         data.previewSmall.mainView,
         isColor
      );

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

   var success     = false;
   var errMessage  = "";
   var keptStarsId = "";
   try
   {
      // Copy stars at full res into the temp window and run the stretch
      // pipeline on it (operates in-place).
      copyInto( data.starsView.id, tw.mainView );
      applyArcsinh( tw.mainView, data.stretchIntensity, data.blackPoint );
      if ( isColor )
      {
         applyColorSat( tw.mainView, data.colorBoost );
         if ( data.removeGreen )
            applySCNR( tw.mainView );
      }

      // If the user painted a raster mask, build a full-resolution
      // version by resampling the preview-size mask up to source
      // dimensions. Build the active-shape full-res inline expression
      // by rescaling shape parameters (which were in preview coords)
      // to full-res coords.
      var maskFullWindow = null;
      var maskExpr       = "";
      if ( data.maskStrength > 0 )
      {
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
            // Temporarily upscale the active shape parameters and build
            // the expression; then restore the original shape.
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

         var effective = buildEffectiveMaskExpr( maskFullId, activeFullExpr );
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

      if ( maskFullWindow != null )
         maskFullWindow.forceClose();

      success = true;
   }
   catch ( e )
   {
      errMessage = e.message;
   }
   finally
   {
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
   closeWindowById( ID_MASK_FULL );
   closeWindowById( ID_OVERLAY );
   data.starlessSmall     = null;
   data.starsSmall        = null;
   data.starsProc         = null;
   data.previewSmall      = null;
   data.maskOverlayBitmap = null;
   data.activeShape       = null;
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

   this.setScaledMinSize( 520, 380 );
   this.cursor = new Cursor( StdCursor_OpenHand );

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
         g.fillRect( self.boundsRect, new Brush( 0xff181818 ) );
         if ( self.bitmap == null )
         {
            g.pen = new Pen( 0xff707070 );
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

         // Mask overlay (red-tinted, additive blend so black areas
         // remain transparent against the preview).
         if ( data.maskOverlayBitmap != null )
         {
            try
            {
               g.compositionOperator = 12;   // CompositionOp_Plus
               g.drawScaledBitmap( destRect, data.maskOverlayBitmap );
               g.compositionOperator = 0;
            }
            catch ( ce ) { /* fall through quietly */ }
         }

         // Active shape (editable): outline + handles. Drawn on top of
         // the mask overlay so the user can always see and grab it.
         if ( data.activeShape != null
           && (data.maskTool === "ellipse" || data.maskTool === "rect" ||
               data.activeShape != null) )
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
            g.pen   = new Pen( 0xffff66aa, 2.0 );
            g.brush = new Brush( 0x00000000 );
            g.drawPolygon( pts );

            // Draw the 4 corner handles + the rotation handle.
            var handles = getActiveShapeHandles();
            for ( var h = 0; h < handles.length; ++h )
            {
               var hc = self._imageRectToCanvas(
                  handles[h].x, handles[h].y,
                  handles[h].x, handles[h].y );
               if ( handles[h].mode === "rotate" )
               {
                  // Filled green circle for rotation.
                  g.pen   = new Pen( 0xff66ff66, 1.5 );
                  g.brush = new Brush( 0xff336633 );
                  g.drawEllipse( new Rect( hc.x0 - 6, hc.y0 - 6,
                                           hc.x0 + 6, hc.y0 + 6 ) );
                  // Stem connecting to the shape.
                  var topImg = handles[0];   // NW handle as proxy for "above"
                  // Better: top center of shape.
                  var localTopX = 0, localTopY = -s.ry;
                  var topWx = s.cx + localTopX * co - localTopY * si;
                  var topWy = s.cy + localTopX * si + localTopY * co;
                  var topC  = self._imageRectToCanvas( topWx, topWy, topWx, topWy );
                  g.pen = new Pen( 0xff66ff66, 1.5 );
                  g.drawLine( topC.x0, topC.y0, hc.x0, hc.y0 );
               }
               else
               {
                  // Pink filled squares for resize.
                  g.pen   = new Pen( 0xffffffff, 1.5 );
                  g.brush = new Brush( 0xffff66aa );
                  g.drawRect( new Rect( hc.x0 - 5, hc.y0 - 5,
                                        hc.x0 + 5, hc.y0 + 5 ) );
               }
            }
         }

         // Brush cursor ring when the brush tool is active.
         if ( data.maskTool === "brush" && self._cursorImg != null )
         {
            var radPx = pctToPx( data.brushRadiusPct, bw );
            var cRect = self._imageRectToCanvas(
               self._cursorImg.x - radPx, self._cursorImg.y - radPx,
               self._cursorImg.x + radPx, self._cursorImg.y + radPx );
            g.pen = new Pen( 0xffff66aa, 1.5 );
            g.brush = new Brush( 0x00000000 );
            g.drawEllipse( cRect );
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

      // Brush tool: paint immediately at the cursor.
      if ( data.maskTool === "brush" )
      {
         var p0 = self._canvasToImage( x, y );
         if ( p0 == null ) return;
         self._dragMode    = "draw";
         self._drawStart   = p0;
         self._drawCurrent = p0;
         self._cursorImg   = p0;
         var radPx  = pctToPx( data.brushRadiusPct, self.bitmap.width );
         var feathr = pctToPx( data.maskFeatherPct, self.bitmap.width );
         paintCircleToMask( p0.x, p0.y, radPx, feathr );
         rebuildMaskOverlay();
         scheduleUpdate();
         self.repaint();
         return;
      }

      // Ellipse / Rectangle: either grab a handle on the active shape
      // or start drawing a new active shape (replacing any previous).
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

      // No hit -> start a brand-new active shape.
      var feathr2 = pctToPx( data.maskFeatherPct, self.bitmap.width );
      data.activeShape = {
         type:    data.maskTool,    // "ellipse" or "rect"
         cx:      p.x,
         cy:      p.y,
         rx:      0.5,
         ry:      0.5,
         angle:   0,
         feather: feathr2
      };
      self._dragMode    = "draw";
      self._drawStart   = p;
      self._drawCurrent = p;
      self._cursorImg   = p;
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
         if ( data.maskTool === "brush" && self._dragMode === "draw" )
         {
            var radPx  = pctToPx( data.brushRadiusPct, self.bitmap.width );
            var feathr = pctToPx( data.maskFeatherPct, self.bitmap.width );
            paintCircleToMask( p.x, p.y, radPx, feathr );
            scheduleUpdate();
         }
         else if ( data.activeShape != null )
         {
            var s = data.activeShape;
            if ( self._dragMode === "draw" )
            {
               // Define a bounding-box ellipse/rect from drag start to p.
               s.cx = (self._drawStart.x + p.x) / 2;
               s.cy = (self._drawStart.y + p.y) / 2;
               s.rx = Math.max( 1, Math.abs( p.x - self._drawStart.x ) / 2 );
               s.ry = Math.max( 1, Math.abs( p.y - self._drawStart.y ) / 2 );
               s.angle = 0;
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
      if ( data.maskTool === "brush" )
      {
         // Rebuild overlay once on release, not on every move.
         rebuildMaskOverlay();
      }
      self._dragMode     = null;
      self._dragShapeBak = null;
      scheduleUpdate();
      self.repaint();
   };

   // Switch the cursor whenever the tool changes externally (combo box).
   this.refreshCursor = function()
   {
      if ( data.maskTool === "pan" )
         self.cursor = new Cursor( StdCursor_OpenHand );
      else
         self.cursor = new Cursor( StdCursor_Cross );
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

   this.resetBtn = new PushButton( this );
   this.resetBtn.text    = "Reset";
   this.resetBtn.toolTip = "Restore AstroDL defaults (Intensity 200, Black Point 0, Boost 1, no SCNR).";
   this.resetBtn.onClick = function()
   {
      data.stretchIntensity = STRETCH_DEF;
      data.blackPoint       = BLACK_DEF;
      data.colorBoost       = BOOST_DEF;
      data.removeGreen      = false;
      self.stretchNC.setValue( data.stretchIntensity );
      self.blackNC.setValue( data.blackPoint );
      self.boostNC.setValue( data.colorBoost );
      self.scnrCheck.checked = data.removeGreen;
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
      "ArcsinhStretch intensity (Lupton et al. 1999).\n" +
      "Maps directly to ArcsinhStretch.stretch. Range 1-1000.\n" +
      "Default 200. Lower for sparse fields, higher for faint stars.";
   this.stretchNC.onValueUpdated = function( v )
   {
      data.stretchIntensity = v;
      scheduleUpdate();
   };

   // ---- Black Point (0..0.05, default 0) - ArcsinhStretch.blackPoint ----
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
   scnrLabel.text          = "Remove Green via SCNR:";
   scnrLabel.setFixedWidth( labelWidth );
   scnrLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.scnrCheck = new CheckBox( this );
   this.scnrCheck.text    = "";
   this.scnrCheck.checked = data.removeGreen;
   this.scnrCheck.toolTip = "Apply SCNR Green (AverageNeutral, preserveLightness) on the stretched stars.";
   this.scnrCheck.onCheck = function( c )
   {
      data.removeGreen = c;
      scheduleUpdate();
   };

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
   this.maskToolCombo.addItem( "Off / Pan view" );
   this.maskToolCombo.addItem( "Ellipse (drag to draw)" );
   this.maskToolCombo.addItem( "Rectangle (drag to draw)" );
   this.maskToolCombo.addItem( "Brush (drag to paint)" );
   this.maskToolCombo.currentItem = 0;
   this.maskToolCombo.toolTip =
      "Select a drawing tool to paint the mask. The mask reduces the " +
      "contribution of the stars layer in painted areas, so the gas / " +
      "nebulosity from the starless shows through more clearly.\n" +
      "Off / Pan view: classic preview navigation (drag to pan).";
   this.maskToolCombo.onItemSelected = function( idx )
   {
      var newTool = ["pan","ellipse","rect","brush"][ idx ];
      // When switching AWAY from an editable-shape tool, auto-commit
      // any active shape so the user doesn't lose work.
      if ( newTool !== data.maskTool && data.activeShape != null )
      {
         commitActiveShape();
         rebuildMaskOverlay();
      }
      data.maskTool = newTool;
      if ( self.previewFrame )
      {
         self.previewFrame.refreshCursor();
         self.previewFrame.repaint();
      }
      scheduleUpdate();
   };

   this.maskCommitBtn = new PushButton( this );
   this.maskCommitBtn.text    = "Commit Shape";
   this.maskCommitBtn.toolTip =
      "Bake the current editable ellipse / rectangle into the mask " +
      "and clear it. After commit you can draw a new shape on top.";
   this.maskCommitBtn.onClick = function()
   {
      if ( data.activeShape == null ) return;
      commitActiveShape();
      rebuildMaskOverlay();
      if ( self.previewFrame ) self.previewFrame.repaint();
      scheduleUpdate();
   };

   this.maskInvertCheck = new CheckBox( this );
   this.maskInvertCheck.text    = "Invert";
   this.maskInvertCheck.checked = data.maskInvert;
   this.maskInvertCheck.toolTip =
      "When checked, the mask SHOWS stars only inside the painted area " +
      "and hides them everywhere else - useful to keep stars only on a " +
      "specific region (e.g. a galaxy core) and remove them around it.";
   this.maskInvertCheck.onCheck = function( c )
   {
      data.maskInvert = c;
      scheduleUpdate();
   };

   this.maskClearBtn = new PushButton( this );
   this.maskClearBtn.text    = "Clear Mask";
   this.maskClearBtn.toolTip = "Reset the mask and discard the editable shape: " +
                               "stars are restored everywhere.";
   this.maskClearBtn.onClick = function()
   {
      data.activeShape = null;
      clearMask();
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
      data.outputId = this.text.length > 0 ? this.text : "Combined";
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
   this.sizer.add( this.blackNC );
   this.sizer.add( this.boostNC );
   this.sizer.add( scnrRow );
   this.sizer.add( keepRow );
   this.sizer.add( maskToolRow );
   this.sizer.add( this.maskStrengthNC );
   this.sizer.add( this.maskFeatherNC );
   this.sizer.add( this.brushRadiusNC );
   this.sizer.add( this.previewFrame, 100 );
   this.sizer.add( btmRow );
   this.sizer.add( this.creditLabel );

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
