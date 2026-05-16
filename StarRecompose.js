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
#define VERSION       "1.1"

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

// Slider ranges. STRETCH is shown to the user as 1..1000 (a familiar
// linear scale) but is multiplied by STRETCH_INTERNAL_X before being
// passed to ArcsinhStretch.stretch, so the UI maximum (1000) actually
// produces an internal stretch of 5000 - enough to fully blow out the
// brightest stars without exposing the underlying scaling to the user.
// BLACK_POINT maps directly to ArcsinhStretch.blackPoint. BOOST is a
// multiplier for our own ColorSaturation hat-curve.
#define STRETCH_MIN          1.0
#define STRETCH_MAX          1000.0
#define STRETCH_DEF          200.0
#define STRETCH_INTERNAL_X   5.0

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
//    preserved instead of being clipped to white.
//
//    The UI intensity (1..1000) is scaled by STRETCH_INTERNAL_X before
//    being passed in, so the slider feels like a familiar 0..1000
//    range while the underlying stretch can reach much higher values
//    for a true blow-out at the top of the slider.
function applyArcsinh( view, intensityUI, blackPoint )
{
   var AS = new ArcsinhStretch;
   AS.stretch              = intensityUI * STRETCH_INTERNAL_X;
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

// 5. Combine:  destView = min(1, starless + starsProcessed)
function applyCombine( starlessId, starsProcId, destView )
{
   var pm = new PixelMath;
   pm.expression          = "min(1," + starlessId + "+" + starsProcId + ")";
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

// Run the full pipeline: copy stars -> stretch -> (sat + scnr) -> combine.
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
   applyCombine( starlessId, procView.id, targetView );
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

      // Final combine creates the output image via createNewImage.
      var pm = new PixelMath;
      pm.expression           = "min(1," + data.starlessView.id + "+" + ID_TMP_FULL + ")";
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
   data.starlessSmall = null;
   data.starsSmall    = null;
   data.starsProc     = null;
   data.previewSmall  = null;
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

   this.onPaint = function()
   {
      var g = new Graphics( self );
      try
      {
         g.fillRect( self.boundsRect, new Brush( 0xff181818 ) );
         if ( self.bitmap != null )
         {
            var bw    = self.bitmap.width;
            var bh    = self.bitmap.height;
            var cw    = self.width;
            var ch    = self.height;
            var scale = self._currentScale();
            var dw    = bw * scale;
            var dh    = bh * scale;
            var dx    = (cw - dw) / 2 + self.panX;
            var dy    = (ch - dh) / 2 + self.panY;
            g.drawScaledBitmap( new Rect( dx, dy, dx + dw, dy + dh ), self.bitmap );
         }
         else
         {
            g.pen = new Pen( 0xff707070 );
            g.drawTextRect(
               self.boundsRect,
               "Select a Starless and a Stars image",
               TextAlign_Center | TextAlign_VertCenter );
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
      var factor = (delta > 0) ? 1.25 : 0.80;
      self._zoomAt( x, y, factor );
   };

   this.onMousePress = function( x, y, button, buttons, modifiers )
   {
      self._panning       = true;
      self._panStart.x    = x;
      self._panStart.y    = y;
      self._panStart.panX = self.panX;
      self._panStart.panY = self.panY;
      self.cursor = new Cursor( StdCursor_ClosedHand );
   };

   this.onMouseMove = function( x, y, buttons, modifiers )
   {
      if ( !self._panning ) return;
      self.panX = self._panStart.panX + (x - self._panStart.x);
      self.panY = self._panStart.panY + (y - self._panStart.y);
      self.repaint();
   };

   this.onMouseRelease = function( x, y, button, buttons, modifiers )
   {
      if ( self._panning )
      {
         self._panning = false;
         self.cursor = new Cursor( StdCursor_OpenHand );
      }
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
      "ArcsinhStretch intensity (Lupton et al. 1999). Linear slider " +
      "from 1 to 1000.\n" +
      "Default 200 (sensible starting point). Push toward 1000 to " +
      "fully blow out the brightest star cores; the curve is scaled " +
      "internally so the high end has real headroom.";
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
   this.creditLabel.text = BRAND + " - " + TOOL + " v" + VERSION + " - by luisjosedl - MIT License";
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
   this.sizer.add( this.previewFrame, 100 );
   this.sizer.add( btmRow );
   this.sizer.add( this.creditLabel );

   this.adjustToContents();
   this.setMinSize( 680, 780 );

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
